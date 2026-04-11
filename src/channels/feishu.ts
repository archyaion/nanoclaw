import fs from 'fs';
import path from 'path';

import * as lark from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import { getFeishuUsers, setFeishuUser } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

function getProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxy) return undefined;
  return new HttpsProxyAgent(proxy);
}

const JID_PREFIX = 'feishu:';

// Code / config file extensions that the bot will download and make available to the agent
const CODE_FILE_EXTENSIONS = new Set([
  // JVM
  '.java',
  '.kt',
  '.kts',
  '.gradle',
  // Web / Node
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  // Python
  '.py',
  // Go
  '.go',
  // Shell
  '.sh',
  '.bash',
  // Config / data
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.xml',
  '.properties',
  '.ini',
  '.env.example',
  '.log',
  // Docs
  '.md',
  '.txt',
  '.csv',
  // Docker / CI
  '.dockerfile',
  // SQL
  '.sql',
  // Protobuf / gRPC
  '.proto',
]);

function isCodeFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  // Handle Dockerfile (no extension)
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return true;
  const ext = path.extname(lower);
  return CODE_FILE_EXTENSIONS.has(ext);
}

function toJid(chatId: string): string {
  return `${JID_PREFIX}${chatId}`;
}

function toChatId(jid: string): string {
  return jid.slice(JID_PREFIX.length);
}

class FeishuChannel implements Channel {
  name = 'feishu';
  private client: InstanceType<typeof lark.Client>;
  private wsClient: lark.WSClient | null = null;
  private dispatcher: lark.EventDispatcher;
  private connected = false;
  private userNameCache = new Map<string, string>();
  private botOpenId: string | null = null;
  private opts: ChannelOpts;

  constructor(
    private appId: string,
    private appSecret: string,
    opts: ChannelOpts,
  ) {
    this.opts = opts;

    this.client = new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    });

    this.dispatcher = new lark.EventDispatcher({});
    this.dispatcher.register({
      'im.message.receive_v1': (data: any) => this.handleMessage(data),
    });
  }

  async connect(): Promise<void> {
    // Load persisted user name cache from DB
    try {
      const persisted = getFeishuUsers();
      for (const [openId, name] of persisted) {
        this.userNameCache.set(openId, name);
      }
      if (persisted.size > 0) {
        logger.info(
          { count: persisted.size },
          'Feishu: loaded user cache from DB',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Feishu: failed to load user cache from DB');
    }

    // Get bot info for filtering self-messages
    try {
      const botInfo = await this.client.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      });
      if (botInfo?.bot?.open_id) {
        this.botOpenId = botInfo.bot.open_id;
        logger.info({ botOpenId: this.botOpenId }, 'Feishu bot info loaded');
      }
    } catch (err) {
      logger.warn(
        { err },
        'Failed to get Feishu bot info, self-message filtering may not work',
      );
    }

    const agent = getProxyAgent();
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: lark.Domain.Feishu,
      ...(agent ? { agent } : {}),
    });

    await this.wsClient.start({ eventDispatcher: this.dispatcher });
    this.connected = true;
    logger.info('Feishu channel connected via WebSocket');
  }

  async addReaction(
    messageId: string,
    emojiType: string,
  ): Promise<string | null> {
    try {
      const resp = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return resp?.data?.reaction_id || null;
    } catch (err) {
      logger.debug(
        { messageId, emojiType, err },
        'Failed to add Feishu reaction',
      );
      return null;
    }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (err) {
      logger.debug(
        { messageId, reactionId, err },
        'Failed to remove Feishu reaction',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = toChatId(jid);
    // Feishu has a 4000-char limit per message, split if needed
    const chunks = splitMessage(text, 4000);
    for (const chunk of chunks) {
      // Check if text contains @mentions that we can resolve to real Feishu at-tags
      const mentions = this.resolveAtMentions(chunk);
      if (mentions.length > 0) {
        await this.sendPostMessage(chatId, chunk, mentions);
      } else {
        await this.client.im.message.create({
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          },
          params: { receive_id_type: 'chat_id' },
        });
      }
    }
  }

  private resolveAtMentions(
    text: string,
  ): Array<{ name: string; openId: string }> {
    // Build reverse lookup: name → openId
    const nameToId = new Map<string, string>();
    for (const [openId, name] of this.userNameCache.entries()) {
      if (name !== openId) nameToId.set(name, openId);
    }
    if (nameToId.size === 0) return [];

    // Try to match @mentions by finding cached names in the text after @
    const mentions: Array<{ name: string; openId: string }> = [];
    // Sort names by length (longest first) for greedy matching
    const sortedNames = [...nameToId.keys()].sort(
      (a, b) => b.length - a.length,
    );
    for (const name of sortedNames) {
      const tag = `@${name}`;
      if (text.includes(tag)) {
        const openId = nameToId.get(name)!;
        mentions.push({ name, openId });
      }
    }
    return mentions;
  }

  private async sendPostMessage(
    chatId: string,
    text: string,
    mentions: Array<{ name: string; openId: string }>,
  ): Promise<void> {
    // Build post content lines by splitting text at @mentions and newlines
    let remaining = text;
    const segments: Array<Record<string, string>> = [];
    for (const mention of mentions) {
      const tag = `@${mention.name}`;
      const idx = remaining.indexOf(tag);
      if (idx === -1) continue;
      if (idx > 0) {
        segments.push({ tag: 'text', text: remaining.slice(0, idx) });
      }
      segments.push({ tag: 'at', user_id: mention.openId });
      remaining = remaining.slice(idx + tag.length);
    }
    if (remaining) {
      segments.push({ tag: 'text', text: remaining });
    }

    // Split segments into lines at newlines (post format requires line arrays)
    // Filter out empty lines — Feishu rejects empty content arrays
    const lines: Array<Array<Record<string, string>>> = [[]];
    for (const seg of segments) {
      if (seg.tag === 'text' && seg.text.includes('\n')) {
        const parts = seg.text.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]) {
            lines[lines.length - 1].push({ tag: 'text', text: parts[i] });
          }
          if (i < parts.length - 1) {
            lines.push([]);
          }
        }
      } else {
        lines[lines.length - 1].push(seg);
      }
    }
    const nonEmptyLines = lines.filter((line) => line.length > 0);

    const postContent = JSON.stringify({
      zh_cn: { title: '', content: nonEmptyLines },
    });
    logger.info(
      { postContent: postContent.slice(0, 500) },
      'Feishu: sending post message',
    );
    await this.client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'post',
        content: postContent,
      },
      params: { receive_id_type: 'chat_id' },
    });
  }

  async sendImage(jid: string, imagePath: string): Promise<void> {
    const chatId = toChatId(jid);
    const imageResp = await this.client.im.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(imagePath),
      },
    });
    const imageKey = imageResp?.image_key;
    if (!imageKey) {
      logger.warn(
        { imagePath },
        'Feishu: image upload failed, no image_key returned',
      );
      return;
    }
    await this.client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
      params: { receive_id_type: 'chat_id' },
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
    }
    this.connected = false;
    logger.info('Feishu channel disconnected');
  }

  private async handleMessage(data: {
    sender: {
      sender_id?: { open_id?: string; user_id?: string; union_id?: string };
      sender_type: string;
    };
    message: {
      message_id: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      create_time: string;
      mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>;
    };
  }): Promise<void> {
    const { sender, message } = data;
    const openId = sender.sender_id?.open_id || '';

    // Skip messages from the bot itself
    if (this.botOpenId && openId === this.botOpenId) return;

    // Handle text, post (rich text), file, and image messages
    const supportedTypes = new Set(['text', 'post', 'file', 'image']);
    if (!supportedTypes.has(message.message_type)) {
      logger.debug(
        { type: message.message_type },
        'Feishu: skipping unsupported message type',
      );
      return;
    }

    let text: string;
    let attachmentNote = '';
    try {
      const parsed = JSON.parse(message.content);
      if (message.message_type === 'post') {
        // Post content may be { zh_cn: { title, content } } or { title, content } directly
        logger.info(
          { postContent: JSON.stringify(parsed).slice(0, 500) },
          'Feishu: post message received',
        );
        let postBody: {
          title?: string;
          content?: Array<Array<Record<string, string>>>;
        };
        if (parsed.zh_cn || parsed.en_us) {
          postBody = parsed.zh_cn || parsed.en_us || Object.values(parsed)[0];
        } else if (parsed.content) {
          postBody = parsed;
        } else {
          postBody = { content: [] };
        }
        const parts: string[] = [];
        if (postBody.title) parts.push(postBody.title);
        if (postBody.content) {
          for (const line of postBody.content) {
            const lineParts: string[] = [];
            for (const elem of line) {
              if (elem.tag === 'text' && elem.text) {
                lineParts.push(elem.text);
              } else if (elem.tag === 'a') {
                lineParts.push(
                  elem.href
                    ? `${elem.text || ''}(${elem.href})`
                    : elem.text || '',
                );
              } else if (elem.tag === 'at') {
                // at elements use user_id, the mention key (@_user_N) is in elem.user_id
                // Pass through as placeholder for mention replacement later
                lineParts.push(
                  elem.user_id ? `@_user_${elem.user_id}` : elem.text || '',
                );
              }
            }
            parts.push(lineParts.join(''));
          }
        }
        text = parts.join('\n');
      } else {
        text = parsed.text || '';
      }
    } catch {
      text = message.content;
    }

    // Handle file messages: download code/config files to the group's attachments dir
    if (message.message_type === 'file') {
      try {
        const parsed = JSON.parse(message.content);
        const fileKey = parsed.file_key as string;
        const fileName = parsed.file_name as string;
        if (fileKey && fileName && isCodeFile(fileName)) {
          const chatJid = toJid(message.chat_id);
          const group = this.opts.registeredGroups()[chatJid];
          if (group) {
            const attachDir = path.join(
              GROUPS_DIR,
              group.folder,
              'attachments',
            );
            fs.mkdirSync(attachDir, { recursive: true });
            const filePath = path.join(attachDir, fileName);
            const resp = await this.client.im.messageResource.get({
              path: { message_id: message.message_id, file_key: fileKey },
              params: { type: 'file' },
            });
            await resp.writeFile(filePath);
            logger.info(
              { fileName, folder: group.folder },
              'Feishu: file downloaded',
            );
            attachmentNote = `\n[附件已保存: attachments/${fileName}]`;
            if (!text) text = `请查看文件 attachments/${fileName}`;
          }
        } else if (fileName && !isCodeFile(fileName)) {
          logger.debug({ fileName }, 'Feishu: skipping non-code file');
          if (!text) return;
        }
      } catch (err) {
        logger.warn({ err }, 'Feishu: failed to download file attachment');
      }
    }

    // Handle image messages: download to attachments dir for agent vision
    if (message.message_type === 'image') {
      try {
        const parsed = JSON.parse(message.content);
        const imageKey = parsed.image_key as string;
        if (imageKey) {
          const chatJid = toJid(message.chat_id);
          const group = this.opts.registeredGroups()[chatJid];
          if (group) {
            const attachDir = path.join(
              GROUPS_DIR,
              group.folder,
              'attachments',
            );
            fs.mkdirSync(attachDir, { recursive: true });
            const fileName = `${imageKey}.png`;
            const filePath = path.join(attachDir, fileName);
            const resp = await this.client.im.messageResource.get({
              path: { message_id: message.message_id, file_key: imageKey },
              params: { type: 'image' },
            });
            await resp.writeFile(filePath);
            logger.info(
              { fileName, folder: group.folder },
              'Feishu: image downloaded',
            );
            attachmentNote = `\n[图片已保存: attachments/${fileName}]`;
            if (!text) text = `请查看图片 attachments/${fileName}`;
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Feishu: failed to download image');
      }
    }

    if (!text && !attachmentNote) return;

    // Replace @mention tags with readable names.
    // When the bot itself is @mentioned, replace with @ASSISTANT_NAME
    // so the trigger pattern matches.
    // Also cache mention names → open_id for outbound @mention resolution.
    if (message.mentions) {
      for (const mention of message.mentions) {
        const mentionOpenId = mention.id?.open_id;
        const isBotMention = this.botOpenId && mentionOpenId === this.botOpenId;
        const replacement = isBotMention
          ? `@${ASSISTANT_NAME}`
          : `@${mention.name}`;
        text = text.replace(mention.key, replacement);
        // Cache the mention name so outbound @mentions can resolve it
        if (mentionOpenId && !isBotMention && mention.name) {
          this.cacheUser(mentionOpenId, mention.name);
        }
      }
    }

    const chatJid = toJid(message.chat_id);
    const isGroup = message.chat_type === 'group';
    const senderName = await this.getSenderName(openId);

    // Emit chat metadata
    const ts = new Date(Number(message.create_time)).toISOString();
    this.opts.onChatMetadata(chatJid, ts, undefined, 'feishu', isGroup);

    // React to acknowledge receipt: groups only, and only when bot is @mentioned
    const group = this.opts.registeredGroups()[chatJid];
    if (group && isGroup) {
      const botMentioned = (message.mentions || []).some(
        (m) => this.botOpenId && m.id?.open_id === this.botOpenId,
      );
      if (botMentioned) {
        this.addReaction(message.message_id, 'OnIt').catch(() => {});
      }
    }

    const msg: NewMessage = {
      id: message.message_id,
      chat_jid: chatJid,
      sender: openId,
      sender_name: senderName,
      content: text + attachmentNote,
      timestamp: ts,
      is_from_me: false,
      is_bot_message: sender.sender_type === 'app',
    };

    this.opts.onMessage(chatJid, msg);
  }

  private cacheUser(openId: string, name: string): void {
    const existing = this.userNameCache.get(openId);
    this.userNameCache.set(openId, name);
    if (existing !== name) {
      try {
        setFeishuUser(openId, name);
      } catch (err) {
        logger.debug({ openId, err }, 'Failed to persist Feishu user to DB');
      }
    }
  }

  private async getSenderName(openId: string): Promise<string> {
    if (!openId) return 'Unknown';

    const cached = this.userNameCache.get(openId);
    if (cached) return cached;

    try {
      const resp = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      const name = resp?.data?.user?.name || openId;
      this.cacheUser(openId, name);
      return name;
    } catch (err) {
      logger.debug({ openId, err }, 'Failed to get Feishu user name');
      this.userNameCache.set(openId, openId);
      return openId;
    }
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

// Self-register: factory returns null when credentials are missing
registerChannel('feishu', (opts: ChannelOpts) => {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) return null;
  return new FeishuChannel(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET, opts);
});
