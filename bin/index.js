#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

readFile(new URL(join('..', 'package.json'), import.meta.url))
	.then(data => JSON.parse(data))
	.then(({ name, main }) =>
		!name && Promise.reject(new Error('name lost')) ||
		!main && Promise.reject(new Error('main lost')) ||
		Promise.resolve({ name, main })
	)
	.then(({ name, main }) =>
		Promise.all([
			import(join('..', main))
				.catch(() => ({ default: undefined })),
			import(join('..', '..', '..', `${name}.config.js`))
				.catch(() => ({ default: undefined })),
		])
	)
	.then(([
		{ default: proc },
		{ default: conf },
	]) =>
		process.argv.slice(2).reduce((acc, cur) => acc[cur], proc)(conf)
	)
