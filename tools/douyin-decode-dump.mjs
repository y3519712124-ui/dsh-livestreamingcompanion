/**
 * Dump the structure of captured Douyin push frames (field numbers -> values),
 * so the decoder can be written against real data.
 *
 *   node tools/douyin-decode-dump.mjs [frames.jsonl]
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? join(here, 'douyin-frames.jsonl');

function readPb(buf) {
  const out = new Map();
  let i = 0;
  const vint = () => {
    let v = 0n;
    let sh = 0n;
    for (;;) {
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << sh;
      if (!(b & 0x80)) return v;
      sh += 7n;
    }
  };
  while (i < buf.length) {
    const tag = Number(vint());
    const num = tag >> 3;
    const wire = tag & 7;
    let value;
    if (wire === 0) value = vint();
    else if (wire === 1) {
      value = buf.readBigUInt64LE(i);
      i += 8;
    } else if (wire === 2) {
      const len = Number(vint());
      value = buf.subarray(i, i + len);
      i += len;
    } else if (wire === 5) {
      value = BigInt(buf.readUInt32LE(i));
      i += 4;
    } else throw new Error(`wire ${wire}`);
    (out.get(num) ?? out.set(num, []).get(num)).push(value);
  }
  return out;
}
const str = (m, n) => {
  const v = m?.get(n)?.[0];
  return Buffer.isBuffer(v) ? v.toString('utf8') : undefined;
};
const num = (m, n) => {
  const v = m?.get(n)?.[0];
  return typeof v === 'bigint' ? Number(v) : undefined;
};
const bufOf = (m, n) => {
  const v = m?.get(n)?.[0];
  return Buffer.isBuffer(v) ? v : undefined;
};

function dump(msg, depth = 0, maxDepth = 2) {
  const pad = '  '.repeat(depth + 1);
  for (const [k, list] of [...msg.entries()].sort((a, b) => a[0] - b[0])) {
    for (const v of list.slice(0, 3)) {
      if (typeof v === 'bigint') console.log(`${pad}${k}: ${v}`);
      else {
        const printable = /^[\x20-\x7e\u4e00-\u9fff]*$/.test(v.toString('utf8')) && v.length < 80;
        if (printable) console.log(`${pad}${k}: "${v.toString('utf8')}"`);
        else if (v.length > 1 && depth < maxDepth) {
          try {
            const child = readPb(v);
            console.log(`${pad}${k}: { ${v.length}B`);
            dump(child, depth + 1, maxDepth);
            console.log(`${pad}}`);
          } catch {
            console.log(`${pad}${k}: <${v.length}B ${v.subarray(0, 12).toString('hex')}>`);
          }
        } else console.log(`${pad}${k}: <${v.length}B ${v.subarray(0, 12).toString('hex')}>`);
      }
    }
  }
}

const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
console.log('frames:', lines.length);
const methodCounts = new Map();

for (const [idx, line] of lines.entries()) {
  const raw = Buffer.from(line.b64, 'base64');
  let frame;
  try {
    frame = readPb(raw);
  } catch (err) {
    console.log(`#${idx} not PushFrame: ${err.message}`);
    continue;
  }
  const type = str(frame, 7) ?? '';
  let payload = bufOf(frame, 8) ?? Buffer.alloc(0);
  if ((payload[0] === 0x1f && payload[1] === 0x8b) || /gzip/i.test(str(frame, 6) ?? '')) {
    try {
      payload = gunzipSync(payload);
    } catch {
      /* keep */
    }
  }
  let res;
  try {
    res = readPb(payload);
  } catch {
    console.log(`#${idx} payload not Response (type=${type})`);
    continue;
  }
  const messages = (res.get(1) ?? []).filter(Buffer.isBuffer);
  console.log(
    `\n#${idx} frame type=${JSON.stringify(type)} encoding=${str(frame, 6)} logId=${num(frame, 2)} messages=${messages.length} cursor=${str(res, 2)} hb=${num(res, 8)} needAck=${num(res, 9)}`,
  );
  for (const m of messages) {
    const msg = readPb(m);
    const method = str(msg, 1) ?? '?';
    methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
    const body = bufOf(msg, 2);
    console.log(`  - ${method} msgId=${num(msg, 3)} type=${num(msg, 4)} ${body?.length ?? 0}B`);
    if (method.includes('Chat') || method.includes('Gift') || method.includes('Member') || method.includes('Like') || method.includes('Social') || method.includes('Control')) {
      if (body) {
        try {
          dump(readPb(body), 1, 2);
        } catch {
          console.log('    <body not pb>');
        }
      }
    }
  }
}
console.log('\nmethods:', [...methodCounts.entries()].map(([k, v]) => `${k}x${v}`).join(', '));
