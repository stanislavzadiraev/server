import {Transform} from 'stream'
import http2 from 'http2'
import url from 'url'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'

import mime from 'mime'
import forge from 'node-forge'

////////////////////////////////////////////////////////////////////////////////

const mute = false

const noop = _ => _

const log = str =>
  mute && noop(str) ||
  (console.log(str), str)

const err = str =>
  (console.error(str), str)

////////////////////////////////////////////////////////////////////////////////

const STREAMWRAP = (stream, name) =>
  stream
  .setMaxListeners(0)
  .on('error', error =>
    log(`Warning: ${name} stream, ${error.message}.`)
  )
  .on('unpipe', source =>
    source.destroy(Error(`destroying`))
  )
  .on('aborted', () =>
    stream.destroy(Error(`destroying`))
  )

////////////////////////////////////////////////////////////////////////////////

const TESTSTAT = location =>
  fs.promises.stat(location)
  .catch(err => (
    err.code == 'ENOENT' && (err.message = 'no match item'),
    Promise.reject(err)
  ))

////////////////////////////////////////////////////////////////////////////////

const respondheaders = (output, headers) =>
  (output.aborted || output.destroyed || output.closed) && Promise.reject(Error(
    'wrong output state'
  )) ||
  Promise.resolve((
    output.respond(headers),
    output
  ))

const RESPONDEXCUSE = (output, error, action, URL) =>
  respondheaders(output, {
    ':status':
      error.code === 'WRREQ' && 400||
      error.code === 'ENOENT' && 404 ||
      error.code === 'DIRNOTFILE' && 301 ||
      error.code === 'FILENOTDIR' && 301 ||
      500,
    'content-type':
      'text/plain;charset=utf-8',
    'location':
      error.code === 'DIRNOTFILE' && (URL.pathname = URL.pathname.concat('/'), URL.format()) ||
      error.code === 'FILENOTDIR' && (URL.pathname = URL.pathname.slice(0, -1), URL.format()) ||
      undefined
  })
  .then(output => (
    output.end(`${error.name}: ${error.message}, ${action}: ${URL.hostname}${URL.pathname}.`)
  ))

const RESPONDSTREAM = (output, type, encoding, source) =>
  respondheaders(output, {
    ':status':
      200,
    'content-type':
      type,
    'content-encoding':
      encoding
  })
  .then(output => (
    source.pipe(output)
  ))

////////////////////////////////////////////////////////////////////////////////

const transit = () =>
  new Transform({
    transform: (chunk, encoding, callback) =>
      setImmediate(callback, null, chunk)
  })

const encoder = {
  'br': () => STREAMWRAP(zlib.createBrotliCompress(), 'brotli'),
  'gzip': () => STREAMWRAP(zlib.createGzip(), 'gzip'),
  'deflate': () => STREAMWRAP(zlib.createDeflate(), 'deflate'),
  'undefined': () => STREAMWRAP(transit(), 'transit')
}

const testfile = location =>
  TESTSTAT(location)
  .then(stat =>
    stat.isFile() && Promise.resolve(
      location
    ) ||
    stat.isDirectory() && Promise.reject(Object.assign(
        Error('illegal operation'),
        {code: 'DIRNOTFILE'}
    ))
  )

const sourcestream = (location, encodings) =>
  testfile(location)
  .then(location =>
    fs.promises.open(location)
  )
  .then(fh =>
    STREAMWRAP(fh.createReadStream({autoClose: true, emitClose: true}), 'source')
  )
  .then(source => [
    `${mime.getType(location) || '*/*'}; charset=utf-8`,
    encodings.includes('br') && 'br' ||
    encodings.includes('gzip') && 'gzip' ||
    encodings.includes('deflate') && 'deflate' ||
    'undefined',
    source
  ])
  .then(([mimetype, encoding, source]) => [
    mimetype,
    encoding,
    source
    .pipe(encoder[encoding]())
  ])

const RESPONDFILE = (output, URL, location, accepts, encodings, languages) =>
  sourcestream(location, encodings)
  .then(([mimetype, encoding, source]) =>
    RESPONDSTREAM(output, mimetype, encoding, source)
  )
  .catch(error =>
    RESPONDEXCUSE(output, error, 'open', URL)
  )
////////////////////////////////////////////////////////////////////////////////

const indexnames = accepts =>
  accepts.split(',')
  .map(acceptItem =>
    acceptItem
    .match(/^\s*((?:[a-z]+|\*)\/(?:(?:[a-z0-9]+)(?:[+\-.][a-z0-9]+)*|\*))(?:;q=([01](?:\.\d+)?))?\s*$/s)
  )
  .map((acceptMatch, itemPosition) => ({
    type: (acceptMatch && acceptMatch[1]) || '',
    weight: (acceptMatch && acceptMatch[2]) || 1,
    pos: itemPosition
  }))
  .filter(acceptItem =>
    acceptItem.type && acceptItem.type !== '*/*' && acceptItem.weight > 0.0
  )
  .sort((a, b) => {
    const aParts = a.type.split('/')
    const bParts = b.type.split('/')
    return (
      b.weight - a.weight ||
      (aParts[0] !== bParts[0] && (a.pos - b.pos)) ||
      (aParts[1] === '*' && bParts[1] !== '*') && 1 ||
      (bParts[1] === '*' && aParts[1] !== '*') && -1 ||
      0
    )
  })
  .map(
    acceptItem =>
    `index.${mime.getExtension(acceptItem.type)}`
  )

const testdir = location =>
  TESTSTAT(location)
  .then(stat =>
    stat.isDirectory() && Promise.resolve(
      location
    ) ||
    stat.isFile() && Promise.reject(Object.assign(
        Error('sillegal operation'),
        {code: 'FILENOTDIR'}
    ))
  )

const sourcefile = (accepts, location) =>
  testdir(location)
  .then(location =>
    Promise.all([
      fs.promises.readdir(location, 'utf8'),
      indexnames(accepts)
    ])
  )
  .then(([availables, acceptables]) =>
    acceptables.find(
      acceptable =>
      availables.find(
        available =>
        acceptable === available
      )
    )
  )
  .then(filename =>
    filename && Promise.resolve(
      filename
    ) ||
    Promise.reject(Error(
     'no match file'
    ))
  )

const RESPONDDIR = (output, URL, location, accepts, encodings, languages) =>
  sourcefile(accepts, location)
  .then(filename => RESPONDFILE(
    output,
    (URL.pathname += filename, URL),
    path.join(location, filename),
    accepts,
    encodings
  ))
  .catch(error =>
    RESPONDEXCUSE(output, error, 'scan', URL)
  )

////////////////////////////////////////////////////////////////////////////////

const SELFSIGNED = hostnames =>
  Promise.resolve(
    forge.pki.rsa.generateKeyPair(2048)
  )
  .then(keys => [
    keys,
    Object.assign(forge.pki.createCertificate(), {
      publicKey: keys.publicKey,
      validity: {
        notBefore: new Date((new Date).setFullYear((new Date).getFullYear() - 1)),
        notAfter: new Date((new Date).setFullYear((new Date).getFullYear() + 2))
      }
    })
  ])
  .then(([keys, cert]) => (
    cert.setSubject([{
      name: 'commonName',
      value: `/ ${hostnames.join(' / ') || 'default'} /`
    }]),
    cert.setIssuer([{
      name: 'commonName',
      value: `/ ${hostnames.join(' / ') || 'default'} /`
    }]),
    cert.setExtensions([{
      name: 'basicConstraints',
      cA: true
    }, {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true
    }, {
      name: 'subjectAltName',
      altNames: hostnames.map(name => ({
        type: /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(name) && 7 ||
          /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/.test(name) && 6 ||
          null,
        value: name
      }))
    }]),
    cert.sign(keys.privateKey, forge.md.sha256.create()),
    [
      forge.pki.certificateToPem(cert),
      forge.pki.privateKeyToPem(keys.privateKey),
      forge.pki.publicKeyToPem(keys.publicKey)
    ]
  ))

////////////////////////////////////////////////////////////////////////////////

const TOUCHSIGNS = (hostnames, mapSignname) =>
  Promise.resolve(
    ['certificate', 'private', 'public']
    .map(name =>
      `${mapSignname(hostnames.join('-'))}.${name}.pem`
    )
  )
  .then(filenames =>
    Promise.all(filenames
      .map(filename =>
        fs.promises.readFile(filename)
      )
    )
    .catch(error => (
      log(
        'Warning: certificate or one or more of keys not loaded, selfsigned generating.'
      ),
      SELFSIGNED(hostnames)
      .then(pems =>
        Promise.all(
          filenames
          .map((filename, index) =>
            fs.promises.writeFile(filename, pems[index])
          )
        )
        .catch(error =>
          log(
            'Warning: certificate or one or more of keys not saved, ignored.'
          )
        )
        .then(() =>
          pems
        )
      )
    ))
  )

////////////////////////////////////////////////////////////////////////////////

const TOUCHROOTS = (hostnames, mapHostname) =>
  Promise.all(
    hostnames
    .map(hostname =>
      mapHostname(hostname)
    )
    .map((pathname) =>
      fs.promises.readdir(pathname)
      .catch(error => (
        log(
          `Warning: source path '${pathname}' not found, empty creating.`
        ),
        fs.promises.mkdir(pathname)
        .catch(error =>
          log(
            `Warning: source path '${pathname}' not created, ignored.`
          )
        )
      ))
      .then(() =>
        pathname
      )
    )
  )

////////////////////////////////////////////////////////////////////////////////

const getlocation = (URL, mapHostname, mapPathname) =>
  Promise.all(
    [
      ['hostname', url.domainToUnicode(URL.hostname)],
      ['pathname', path.normalize(URL.pathname)]
    ]
    .map(([key, value]) =>
      value &&
      Promise.resolve(
        value
      ) ||
      Promise.reject(Error(
        `empty ${key}`
      ))
    )
  )
  .then(([hostname, pathname]) =>
    path.join(
      mapHostname(hostname, pathname),
      mapPathname(pathname, hostname)
    )
  )

const RESPONDGET = (URL, mapHostname, mapPathname, accepts, encodings, languages, output) =>
  getlocation(
    URL,
    mapHostname,
    mapPathname
  )
  .then(location =>
    (location.slice(-1) === path.sep && RESPONDDIR || RESPONDFILE)(
      STREAMWRAP(output, 'output'),
      URL,
      location,
      accepts,
      encodings,
      languages
    )
  )
  .catch(error =>
    RESPONDEXCUSE(output, error, 'on GET', URL)
  )

////////////////////////////////////////////////////////////////////////////////

const validMethod = (headers, method) =>
  headers[':method'] === method &&
  headers[':scheme'] &&
  headers[':authority'] &&
  headers[':path']

const validHostname = (headers, hostnames) =>
  Promise.resolve(
    url.parse(
      `${headers[':scheme']}://${headers[':authority']}${headers[':path']}`
    )
  )
  .then(URL =>
    hostnames.includes(url.domainToUnicode(URL.hostname)) &&
    Promise.resolve(
      URL
    ) ||
    Promise.reject(Error(
      'wrong hostname'
    ))
  )

const INDEX = ({
    hostnames = ['localhost'],
    mapHostname = noop,
    mapSignname = noop,
    mapPathname = noop,
    listens,
  }) =>
  Promise.all([
    TOUCHROOTS(hostnames, mapHostname),
    TOUCHSIGNS(hostnames, mapSignname)
  ])
  .then(([ , [cert, key, ]]) =>
    listens.map(listen =>
      http2.createSecureServer({cert, key})
      .listen(listen)
      .on('stream', (output, headers) =>
        validHostname(headers, hostnames)
        .then(URL =>

          validMethod(headers, 'GET') &&
          RESPONDGET(
            URL,
            mapHostname,
            mapPathname,
            headers['accept'] || '',
            headers['accept-encoding'] || '',
            headers['accept-language'] || '',
            output
          ) ||

          output.destroy()
        )
        .catch(error =>
          output.destroy()
        )
      )
    )
  )

export default INDEX
