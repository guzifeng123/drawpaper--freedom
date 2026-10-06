import { describe, it, expect } from 'vitest';
import { detectTransportKind, SITE_CHANNEL, docChannel } from './transport';

describe('传输降级探测 detectTransportKind', () => {
  it('有 BroadcastChannel → broadcast-channel（首选）', () => {
    expect(detectTransportKind({ BroadcastChannel: function BC() {}, localStorage: {} })).toBe(
      'broadcast-channel',
    );
  });

  it('无 BroadcastChannel 但有 localStorage → storage 兜底', () => {
    expect(detectTransportKind({ BroadcastChannel: undefined, localStorage: {} })).toBe('storage');
  });

  it('两者皆无 → disabled（单标签静默降级）', () => {
    expect(detectTransportKind({ BroadcastChannel: undefined, localStorage: undefined })).toBe('disabled');
  });
});

describe('通道命名', () => {
  it('站点级与文档级通道可区分', () => {
    expect(SITE_CHANNEL).toContain('site');
    expect(docChannel('doc-abc')).toBe('drawpaper-collab:v1:doc:doc-abc');
    expect(docChannel('doc-abc')).not.toBe(SITE_CHANNEL);
  });
});
