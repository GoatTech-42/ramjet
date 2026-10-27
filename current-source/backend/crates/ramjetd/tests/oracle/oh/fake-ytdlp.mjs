#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const url = args[args.length - 1];
const fx = JSON.parse(fs.readFileSync('/tmp/oracle2/fixtures.json', 'utf8'));
fs.appendFileSync('/tmp/oracle2/ytdlp-calls.log', 'YD|' + url + (args.includes('--playlist-end') ? '|end=' + args[args.indexOf('--playlist-end') + 1] : '') + '\n');
const ei = args.indexOf('--playlist-end');
const f = (ei >= 0 ? fx['YD|' + url + '|end=' + args[ei + 1]] : null) || fx['YD|' + url];
if (!f) { process.stderr.write('ERROR: no fixture ' + url); process.exit(1); }
if (f.error) { process.stderr.write(f.error); process.exit(1); }
process.stdout.write(JSON.stringify(f.json));
