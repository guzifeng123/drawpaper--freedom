/**
 * 手写 WebDAV 客户端（Wave10 阶段 B）。
 *
 * 红线：
 * - 不引任何 webdav / XML 解析库；只用 fetch + DOMParser（web 环境）。
 * - 凭据仅由调用方从 localStorage 读入，Basic Auth 头随请求带；本模块不持久化。
 * - http 明文由 UI 层弹安全警告后才允许配置；本模块照发（用户已知情）。
 * - 401 / 网络错误分类成 WebDavError，上层 toast 且不丢本地数据。
 *
 * 只实现同步需要的最小子集：PROPFIND 列清单、GET/PUT 文本与二进制。
 */

export interface WebDavConfig {
  /** 服务器根 URL（末尾可带 /）。如 https://dav.example.com/drawpaper */
  baseUrl: string;
  username: string;
  password: string;
}

export type WebDavErrorKind = 'auth' | 'network' | 'server' | 'bad-response';

export class WebDavError extends Error {
  readonly kind: WebDavErrorKind;
  readonly status?: number;
  constructor(kind: WebDavErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'WebDavError';
    this.kind = kind;
    this.status = status;
  }
}

function basicAuth(config: WebDavConfig): string {
  // 兼容非 ASCII 用户名/密码。
  const raw = `${config.username}:${config.password}`;
  return `Basic ${btoa(unescape(encodeURIComponent(raw)))}`;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  return `${base}/${p}`;
}

/** 路径 → 安全文件名（.kbnote 用 docId 命名，已无分隔符；资产 hash 同理）。 */
export class WebDavClient {
  constructor(private config: WebDavConfig) {}

  private async req(method: string, path: string, init?: RequestInit): Promise<Response> {
    const url = joinUrl(this.config.baseUrl, path);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: basicAuth(this.config),
          ...(init?.headers ?? {}),
        },
        ...init,
      });
    } catch (e) {
      // CORS / DNS / 断网 / 混合内容拦截都走到这里。
      throw new WebDavError('network', `无法连接服务器：${(e as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new WebDavError('auth', '认证失败，请检查用户名/密码', res.status);
    }
    if (res.status >= 500) {
      throw new WebDavError('server', `服务器错误（HTTP ${res.status}）`, res.status);
    }
    return res;
  }

  /** 列根目录下一层条目（文件相对路径）。不存在/空目录返回空数组。 */
  async list(): Promise<string[]> {
    const res = await this.req('PROPFIND', '', {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>',
    });
    if (res.status === 404) return [];
    if (!res.ok && res.status !== 207) {
      throw new WebDavError('server', `PROPFIND 失败（HTTP ${res.status}）`, res.status);
    }
    const xml = await res.text();
    return parseDavListings(xml, this.config.baseUrl);
  }

  async getText(path: string): Promise<string | null> {
    const res = await this.req('GET', path);
    if (res.status === 404) return null;
    if (!res.ok) throw new WebDavError('server', `GET 失败（HTTP ${res.status}）`, res.status);
    return await res.text();
  }

  async putText(path: string, contents: string): Promise<void> {
    const res = await this.req('PUT', path, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: contents,
    });
    if (res.status >= 300) throw new WebDavError('server', `PUT 失败（HTTP ${res.status}）`, res.status);
  }

  async getBytes(path: string): Promise<Uint8Array | null> {
    const res = await this.req('GET', path);
    if (res.status === 404) return null;
    if (!res.ok) throw new WebDavError('server', `GET 失败（HTTP ${res.status}）`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  async putBytes(path: string, bytes: Uint8Array): Promise<void> {
    const res = await this.req('PUT', path, {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (res.status >= 300) throw new WebDavError('server', `PUT 失败（HTTP ${res.status}）`, res.status);
  }
}

/**
 * 解析 PROPFIND 207 XML，返回文件相对路径列表（不含目录自身，不含 assets/ 目录条目本身）。
 * 抽出纯函数（DOMParser 仍依赖 web 环境，但解析逻辑可在有 DOMParser 的环境单测）。
 */
export function parseDavListings(xml: string, baseUrl: string): string[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) return [];
  // WebDAV 响应普遍带命名空间前缀（如 <d:response>/<d:href>），
  // 用 getElementsByTagNameNS('*', …) 做命名空间无关匹配，避免漏解析。
  const responses = Array.from(doc.getElementsByTagNameNS('*', 'response'));
  // PROPFIND 返回的 href 通常是服务器根相对路径（如 /dav/drawpaper/a.kbnote），
  // 这里用 baseUrl 的 pathname 作前缀剥离，不能带 host。
  let basePath = '';
  try {
    basePath = new URL(baseUrl).pathname;
  } catch {
    basePath = baseUrl;
  }
  if (!basePath.endsWith('/')) basePath = basePath + '/';
  const out: string[] = [];
  for (const r of responses) {
    const href = r.getElementsByTagNameNS('*', 'href')[0]?.textContent?.trim() ?? '';
    if (!href) continue;
    const isCollection = r.getElementsByTagNameNS('*', 'collection').length > 0;
    if (isCollection) continue;
    // 去掉 base 路径前缀，保留根目录下的相对路径。
    let rel = decodeUriPath(href);
    // href 可能带 host（绝对 URL）或不带（根相对），二者都剥到 pathname 之后。
    try {
      rel = new URL(rel, 'http://x.local').pathname;
    } catch {
      /* 已是相对路径 */
    }
    if (rel.startsWith(basePath)) rel = rel.slice(basePath.length);
    rel = rel.replace(/^\/+/, '');
    if (!rel) continue;
    out.push(rel);
  }
  return out.sort();
}

function decodeUriPath(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
