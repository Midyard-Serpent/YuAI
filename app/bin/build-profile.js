'use strict';

const { runBuild } = require('../lib/build');

const argv = process.argv.slice(2);
const extract = argv.includes('--extract');
const mock = argv.includes('--mock');

runBuild({ extract, mock })
  .catch((e) => {
    console.error('[profile] 失败:', e.message || e);
    process.exit(1);
  });