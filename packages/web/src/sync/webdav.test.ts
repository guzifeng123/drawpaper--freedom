import { describe, it, expect } from 'vitest';
import { parseDavListings } from './webdav';

const SAMPLE = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/drawpaper/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/drawpaper/abc.kbnote</d:href>
    <d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/drawpaper/def.kbnote</d:href>
    <d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/drawpaper/assets/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
</d:multistatus>`;

describe('parseDavListings', () => {
  it('过滤目录，返回根目录下文件相对路径', () => {
    const out = parseDavListings(SAMPLE, 'https://host/dav/drawpaper/');
    expect(out).toEqual(['abc.kbnote', 'def.kbnote']);
  });

  it('坏 XML 返回空数组（不抛）', () => {
    expect(parseDavListings('not xml <<<', 'https://host/')).toEqual([]);
  });
});
