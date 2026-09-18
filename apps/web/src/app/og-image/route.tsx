import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function GET() {
  const icon = await readFile(join(process.cwd(), 'src/app/icon.png'));
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: 90,
        background: '#f7f8f5',
        color: '#20251e',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <img
          src={`data:image/png;base64,${icon.toString('base64')}`}
          width={90}
          height={90}
          style={{ borderRadius: 22 }}
          alt=""
        />
        <span style={{ fontSize: 76, fontWeight: 700 }}>FormatOwl.</span>
      </div>
    </div>,
    { width: 1200, height: 630 },
  );
}
