/**
 * Parses WordNet data files and produces a compact dictionary.json.
 *
 * Output format:
 *   { "word": [["n", "definition"], ["v", "definition"]], ... }
 *
 * Only single words (no phrases), max 3 definitions per word.
 * Strips example sentences from glosses for compactness.
 */

const fs = require('fs');
const path = require('path');
const wndb = require('wordnet-db');

const DATA_FILES = {
  'data.noun': 'n',
  'data.verb': 'v',
  'data.adj': 'adj',
  'data.adv': 'adv',
};

const dict = Object.create(null);

for (const [file, pos] of Object.entries(DATA_FILES)) {
  const filePath = path.join(wndb.path, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  for (const line of lines) {
    // Header lines start with spaces
    if (!line || line.startsWith(' ')) continue;

    // Split on ' | ' to separate relational data from gloss
    const pipeIdx = line.indexOf(' | ');
    if (pipeIdx === -1) continue;

    const rawGloss = line.substring(pipeIdx + 3).trim();
    // Take only the definition part, strip examples (after semicolons and in quotes)
    let definition = rawGloss
      .replace(/\s*"[^"]*"/g, '') // remove quoted examples
      .split(';')[0]              // take first definition only
      .trim()
      .replace(/\s+/g, ' ');      // normalize whitespace
    // Truncate overly long definitions
    if (definition.length > 150) {
      definition = definition.substring(0, 147) + '...';
    }
    if (!definition) continue;

    const left = line.substring(0, pipeIdx);
    const parts = left.split(' ');

    // Format: synset_offset lex_filenum ss_type w_cnt word lex_id [word lex_id...] p_cnt ...
    const wCnt = parseInt(parts[3], 16);

    for (let i = 0; i < wCnt; i++) {
      let word = parts[4 + i * 2];
      if (!word) continue;
      word = word.replace(/_/g, ' ').toLowerCase();

      // Skip multi-word phrases and single characters
      if (word.includes(' ') || word.length <= 1) continue;
      // Skip words with digits or special chars
      if (/[^a-z'-]/.test(word)) continue;

      if (!dict[word]) dict[word] = [];

      // Avoid duplicate definitions for the same POS
      const exists = dict[word].some((d) => d[0] === pos && d[1] === definition);
      if (!exists) {
        dict[word].push([pos, definition]);
      }
    }
  }
}

// Cap definitions per word to keep size down
for (const word of Object.keys(dict)) {
  if (dict[word].length > 3) {
    dict[word] = dict[word].slice(0, 3);
  }
}

const output = JSON.stringify(dict);
const outPath = path.join(__dirname, '..', 'dictionary.json');
fs.writeFileSync(outPath, output);

const wordCount = Object.keys(dict).length;
const sizeMB = (output.length / 1024 / 1024).toFixed(1);
console.log(`Dictionary built: ${wordCount} words, ${sizeMB}MB → ${outPath}`);
