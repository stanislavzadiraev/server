#!/usr/bin/env node

process.title = 'node'
process.removeAllListeners('warning')

const I = ' - '
const C = '../'

const curpath = new Array(1).fill(C).join('')
const parpath = new Array(3).fill(C).join('')

const srcname = 'src'
const dstname = 'dst'


Promise
.all([
  import(curpath + 'package.json', { assert: { type: 'json' } }),
  import(parpath + 'package.json', { assert: { type: 'json' } }),
])
.then(([
  {default: {name: curname}},
  {default: {name: parname}},
]) => (
  process.title += I + parname + I + curname,
  Promise
  .all([
    import(curpath + dstname + '/index.js'),
    import(parpath + curname + '.config.js'),
  ])
))
.then(([
  {default: mdl},
  {default: cfg},
]) => (
  mdl(cfg)
))
