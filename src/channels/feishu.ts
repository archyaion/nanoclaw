import * as lark from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ASSISTANT_NAME } from '../config.js';
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
      'im.message.receive_v1': (data) => this.handleMessage(data),
    });
  }

  async connect(): Promise<void> {
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

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = toChatId(jid);
    // Feishu has a 4000-char limit per message, split if needed
    const chunks = splitMessage(text, 4000);
    for (const chunk of chunks) {
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

    // Only handle text messages for now
    if (message.message_type !== 'text') {
      logger.debug(
        { type: message.message_type },
        'Feishu: skipping non-text message',
      );
      return;
    }

    let text: string;
    try {
      const parsed = JSON.parse(message.content);
      text = parsed.text || '';
    } catch {
      text = message.content;
    }
    if (!text) return;

    // Replace @mention tags with readable names.
    // When the bot itself is @mentioned, replace with @ASSISTANT_NAME
    // so the trigger pattern matches.
    if (message.mentions) {
      for (const mention of message.mentions) {
        const isBotMention =
          this.botOpenId && mention.id?.open_id === this.botOpenId;
        const replacement = isBotMention
          ? `@${ASSISTANT_NAME}`
          : `@${mention.name}`;
        text = text.replace(mention.key, replacement);
      }
    }

    const chatJid = toJid(message.chat_id);
    const isGroup = message.chat_type === 'group';
    const senderName = await this.getSenderName(openId);

    // Emit chat metadata
    const ts = new Date(Number(message.create_time)).toISOString();
    this.opts.onChatMetadata(chatJid, ts, undefined, 'feishu', isGroup);

    const msg: NewMessage = {
      id: message.message_id,
      chat_jid: chatJid,
      sender: openId,
      sender_name: senderName,
      content: text,
      timestamp: ts,
      is_from_me: false,
      is_bot_message: sender.sender_type === 'app',
    };

    this.opts.onMessage(chatJid, msg);
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
      this.userNameCache.set(openId, name);
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
