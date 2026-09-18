import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WatermarkView, WatermarkSelection } from '@filemorph/core/watermark';
const origin = 'http://127.0.0.1:3000',
  root = resolve('.data/watermark-test');
export class Client {
  cookie = '';
  async call<T = any>(
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    expected = 200,
  ): Promise<T> {
    const response = await fetch(origin + '/api/' + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: this.cookie,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie())
      if (cookie.startsWith('fm-session=')) this.cookie = cookie.split(';')[0];
    const data = await response.json();
    assert.equal(response.status, expected, path + ' ' + JSON.stringify(data));
    return data;
  }
  async upload(name: string, folder = root) {
    const bytes = await readFile(resolve(folder, name));
    const r = await this.call('uploads', { name, size: bytes.length });
    for (let offset = 0, n = 1; offset < bytes.length; offset += r.partSize, n++) {
      const { url } = await this.call('uploads/' + r.id + '/parts', { partNumber: n });
      assert.equal(
        (await fetch(url, { method: 'PUT', body: bytes.subarray(offset, offset + r.partSize) }))
          .status,
        200,
      );
    }
    await this.call('uploads/' + r.id + '/complete', {});
    return r.id;
  }
  async finish(id: string, runId?: string) {
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const v = await this.call<WatermarkView>('jobs/' + id + '/watermark');
      const j = runId ? v.runs.find((r) => r.id === runId) : (await this.call('jobs/' + id)).job;
      if (j && ['completed', 'failed', 'cancelled'].includes(j.state)) {
        assert.equal(j.state, 'completed', j.error);
        // The job may complete between the watermark and job requests. Read the
        // document again after completion instead of returning the earlier view.
        return runId ? v : this.call<WatermarkView>('jobs/' + id + '/watermark');
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    throw new Error('Timed out ' + id);
  }
}
if (import.meta.url === new URL('file://' + process.argv[1]).href) {
  const a = new Client(),
    b = new Client();
  await mkdir(root, { recursive: true });
  await a.call('session');
  await b.call('session');
  const records: any[] = [];
  for (const [fmt, tool] of [
    ['png', 'image'],
    ['pdf', 'pdf'],
    ['docx', 'word'],
    ['pptx', 'ppt'],
  ] as const) {
    const assetId = await a.upload('sample.' + fmt),
      requestId = crypto.randomUUID();
    const { id } = await a.call('jobs', {
      assetId,
      requestId,
      tool: tool + '-watermark-remover',
      options: {},
    });
    assert.equal(
      (await a.call('jobs', { assetId, requestId, tool: tool + '-watermark-remover', options: {} }))
        .id,
      id,
    );
    let v = await a.finish(id);
    assert.ok(v.data);
    assert.ok(!JSON.stringify(v.data).includes('locator'));
    assert.ok(!JSON.stringify(v.data).includes('imagePath'));
    await b.call('jobs/' + id + '/watermark', undefined, 'GET', 404);
    await b.call('jobs/' + id + '/watermark/media?page=0', undefined, 'GET', 404);
    const selected: WatermarkSelection =
      fmt === 'png'
        ? {
            candidates: [],
            regions: [
              {
                id: crypto.randomUUID(),
                targetId: 'image',
                kind: 'rect',
                x: 0.62,
                y: 0.77,
                width: 0.33,
                height: 0.16,
                strokes: [],
              },
            ],
          }
        : {
            candidates: [
              v.data!.candidates.find((c) => c.label.includes('SAMPLE') && c.pages.includes(0))!.id,
            ],
            regions: [],
          };
    await a.call(
      'jobs/' + id + '/watermark',
      { revision: v.revision, candidates: ['not-a-real-object'], regions: [] },
      'PATCH',
      400,
    );
    await a.call(
      'jobs/' + id + '/watermark',
      { revision: v.revision, ...selected, outputKey: 'bad' },
      'PATCH',
      400,
    );
    const saved = await a.call(
      'jobs/' + id + '/watermark',
      { revision: v.revision, ...selected },
      'PATCH',
    );
    await a.call('jobs/' + id + '/watermark', { revision: v.revision, ...selected }, 'PATCH', 409);
    const previewBody = {
      requestId: crypto.randomUUID(),
      revision: saved.revision,
      kind: 'preview',
      page: 0,
    };
    const preview = await a.call('jobs/' + id + '/watermark/runs', previewBody);
    assert.equal((await a.call('jobs/' + id + '/watermark/runs', previewBody)).id, preview.id);
    v = await a.finish(id, preview.id);
    const media = await a.call('jobs/' + id + '/watermark/media?page=0&run=' + preview.id);
    assert.equal((await fetch(media.url)).status, 200);
    const result = await a.call('jobs/' + id + '/watermark/runs', {
      requestId: crypto.randomUUID(),
      revision: saved.revision,
      kind: 'export',
      format: fmt,
    });
    v = await a.finish(id, result.id);
    const { url } = await a.call('watermark-runs/' + result.id + '/download');
    await b.call('watermark-runs/' + result.id + '/download', undefined, 'GET', 404);
    const before = Buffer.from(await (await fetch(url)).arrayBuffer());
    await writeFile(resolve(root, 'api-result.' + fmt), before);
    await a.call(
      'jobs/' + id + '/watermark',
      { revision: saved.revision, candidates: [], regions: [] },
      'PATCH',
    );
    const same = await a.call('watermark-runs/' + result.id + '/download');
    assert.deepEqual(Buffer.from(await (await fetch(same.url)).arrayBuffer()), before);
    await a.call(
      'jobs/' + id + '/watermark',
      { revision: saved.revision + 1, ...selected },
      'PATCH',
    );
    records.push({ fmt, id, runId: result.id });
    console.log(
      'PASS',
      fmt,
      'upload, analysis, ownership, selections, conflict, preview, editable export, immutable download',
    );
  }
  await writeFile(resolve(root, 'report.json'), JSON.stringify(records, null, 2));
  const token = a.cookie.slice('fm-session='.length);
  await writeFile(
    resolve(root, 'browser-state.json'),
    JSON.stringify({
      cookies: [
        {
          name: 'fm-session',
          value: token,
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
          expires: Math.floor(Date.now() / 1000) + 86400,
        },
      ],
      origins: [],
    }),
  );
  console.log('PASS watermark API integration; retained synthetic jobs for browser testing');
}
