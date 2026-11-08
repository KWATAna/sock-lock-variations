import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = new URL('.', import.meta.url);
const MAX_HOOK_LENGTH = 72;
const HOOK_DURATION_SECONDS = 3;
const python = process.env.PYTHON_BIN || process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3';

function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw new Error(`${program}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${program}: завершено з кодом ${result.status}`);
  }
  return result.stdout;
}

// Commas and quotes inside quoted fields are supported. A hook is one CSV line.
function parseLine(line) {
  const fields = [];
  let index = 0;
  while (index <= line.length) {
    let value = '';
    if (line[index] === '"') {
      index += 1;
      let closed = false;
      while (index < line.length) {
        if (line[index] !== '"') {
          value += line[index++];
        } else if (line[index + 1] === '"') {
          value += '"';
          index += 2;
        } else {
          index += 1;
          closed = true;
          break;
        }
      }
      if (!closed || (index < line.length && line[index] !== ',')) {
        throw new Error('некоректне поле в лапках');
      }
    } else {
      while (index < line.length && line[index] !== ',') {
        if (line[index] === '"') throw new Error('лапки всередині поля без обрамлення');
        value += line[index++];
      }
    }
    fields.push(value.trim());
    index += 1;
  }
  return fields;
}

function readHooks(path) {
  const lines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = parseLine(lines.shift());
  if (header.length !== 2 || header[0] !== 'id' || header[1] !== 'hook') {
    throw new Error('CSV має починатися із заголовка id,hook.');
  }

  const rows = [];
  const seen = new Set();
  let skipped = 0;
  for (const [offset, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const fields = parseLine(line);
      if (fields.length !== 2) throw new Error('потрібні рівно два поля');
      const [id, hook] = fields;
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) {
        throw new Error('id має містити лише малі латинські літери, цифри й дефіси');
      }
      if (seen.has(id)) throw new Error(`повторний id «${id}»`);
      if (!hook) throw new Error('порожній hook');
      if (Array.from(hook).length > MAX_HOOK_LENGTH) {
        throw new Error(`hook задовгий (максимум ${MAX_HOOK_LENGTH} символи)`);
      }
      if (/[\u0000-\u001F\u007F]/.test(hook)) throw new Error('hook містить керівні символи');
      seen.add(id);
      rows.push({ id, hook });
    } catch (error) {
      skipped += 1;
      console.warn(`Пропущено рядок ${offset + 2}: ${error.message}`);
    }
  }
  return { rows, skipped };
}

function probeVideo(path) {
  if (!/\.mp4$/i.test(path)) throw new Error('Вхідний файл має бути MP4.');
  const { streams, format } = JSON.parse(run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration',
    '-of', 'json', path,
  ]));
  const { width, height, side_data_list = [] } = streams[0] ?? {};
  if (!width || !height || width * 16 !== height * 9 || width % 2 || height % 2 ||
      side_data_list.some(item => Number(item.rotation) % 360)) {
    throw new Error('Потрібне вертикальне відео 9:16 з парними розмірами й без метаданих повороту.');
  }
  if (!(Number(format?.duration) >= HOOK_DURATION_SECONDS)) {
    throw new Error(`Тривалість відео має становити щонайменше ${HOOK_DURATION_SECONDS} секунди.`);
  }
  return { width, height };
}

function renderVariant({ row, video, size, outputDir, temp }) {
  const overlay = join(temp, 'hook.png');
  const staging = join(temp, 'variant.mp4');
  const target = join(outputDir, `${row.id}.mp4`);
  run(python, [
    fileURLToPath(new URL('visuals.py', here)), 'overlay', String(size.width), String(size.height),
    overlay, row.hook,
  ]);
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', video, '-i', overlay,
    '-filter_complex', `[0:v:0][1:v:0]overlay=enable='lt(t,${HOOK_DURATION_SECONDS})'[v]`,
    '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast',
    '-crf', '19', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough',
    '-c:a', 'copy', '-movflags', '+faststart', staging,
  ]);
  renameSync(staging, target);
  console.log(`Готово: ${target}`);
}

function main() {
  const { values: flags } = parseArgs({
    options: {
      demo: { type: 'boolean' }, edge: { type: 'boolean' }, help: { type: 'boolean' },
      video: { type: 'string' }, csv: { type: 'string' }, out: { type: 'string' },
    },
  });
  if (flags.help) {
    console.log('node render.mjs --demo [--edge] [--out out]\n' +
      'node render.mjs --video base.mp4 --csv hooks.csv [--out out]');
    return;
  }
  if ((flags.demo && (flags.video || flags.csv)) || (!flags.demo && (flags.edge || !flags.video || !flags.csv))) {
    throw new Error('Вибери --demo або вкажи обидва параметри --video та --csv. Довідка: --help.');
  }

  const video = flags.demo ? fileURLToPath(new URL('examples/synthetic-base.mp4', here)) : resolve(flags.video);
  const csv = flags.demo
    ? fileURLToPath(new URL(flags.edge ? 'examples/synthetic-hooks-edge.csv' : 'examples/synthetic-hooks.csv', here))
    : resolve(flags.csv);
  const requestedOutputDir = resolve(flags.out ?? 'out');
  const size = probeVideo(video);
  const { rows, skipped } = readHooks(csv);
  if (!rows.length) throw new Error('У CSV немає валідних варіацій.');

  // Fail once with the dependency error before starting the batch.
  run(python, ['-c', 'from PIL import Image, ImageDraw, ImageFont']);
  mkdirSync(requestedOutputDir, { recursive: true });
  const outputDir = realpathSync(requestedOutputDir);
  const originalPaths = new Set([realpathSync(video), join(realpathSync(dirname(video)), basename(video))]);
  // Keep staging on the same filesystem so completed MP4s can be moved atomically.
  const temp = mkdtempSync(join(outputDir, '.socklock-'));
  let rendered = 0;
  let failed = 0;
  try {
    for (const row of rows) {
      try {
        if (originalPaths.has(join(outputDir, `${row.id}.mp4`))) {
          throw new Error('назва вихідного файла збігається з вхідним відео');
        }
        renderVariant({ row, video, size, outputDir, temp });
        rendered += 1;
      } catch (error) {
        failed += 1;
        console.error(`Помилка варіації «${row.id}»: ${error.message}`);
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  console.log(`Експортовано: ${rendered}. Пропущено: ${skipped}. Помилки: ${failed}.`);
  if (failed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`Помилка: ${error.message}`);
  process.exitCode = 1;
}
