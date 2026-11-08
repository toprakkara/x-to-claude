#!/usr/bin/env node
// Creates the archive folder (config.json's archiveDir) from templates/archive:
//   npm run archive:init
// Existing files are never overwritten, so it's safe to run again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../relay/config.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderScript = path.join(projectRoot, 'scripts', 'render-archive.mjs');
const templates = path.join(projectRoot, 'templates', 'archive');

// destination -> template and how to insert the note writer's path
const FILES = [
  ['CLAUDE.md', 'CLAUDE.md', (p) => p],
  ['categories.md', 'categories.md', (p) => p],
  ['log.md', 'log.md', (p) => p],
  ['.claude/settings.json', 'settings.json', (p) => JSON.stringify(p).slice(1, -1)],
];

export function initArchive(dir) {
  const created = [];
  for (const sub of ['inbox', 'library', 'plan']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  for (const [dest, template, encode] of FILES) {
    const target = path.join(dir, dest);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const text = fs.readFileSync(path.join(templates, template), 'utf8').replaceAll('{{RENDER_SCRIPT}}', encode(renderScript));
    fs.writeFileSync(target, text);
    created.push(dest);
  }
  return created;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { archiveDir, archivistName } = loadConfig();
  const created = initArchive(archiveDir);
  console.log(`Archive folder: ${archiveDir}`);
  console.log(created.length ? `Created: ${created.join(', ')}` : 'Already set up; nothing changed.');
  console.log('');
  console.log('Next, start the archivist once and accept the trust dialog; you can exit right after. Until the folder');
  console.log('is trusted, Claude Code ignores its permissions, so background runs can\'t write any notes:');
  console.log(`  cd ${JSON.stringify(archiveDir)} && claude --name ${archivistName} --permission-mode dontAsk --strict-mcp-config`);
  console.log('');
  console.log('Then edit categories.md to suit you.');
}
