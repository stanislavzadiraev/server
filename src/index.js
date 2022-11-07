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
  .on('unpipe', stream._writableState !== undefined && (source =>
    !source._readableState.ended && !source._readableState.destroyed &&
    (source.listenerCount('data') === 1) && source.destroy(Error(
      `unpiped and destroyed`
    ))
  ) || noop)
  .on('error', stream._readableState !== undefined && (error =>
    !stream._readableState.ended && !stream._readableState.destroyed &&
    (stream.listenerCount('data') > 0) && stream.emit('data',
      `\nError: ${error.message}.\n`
    )
  ) || noop)

////////////////////////////////////////////////////////////////////////////////

const responseheaders = headers => ({
  sendHead: output =>
    (output._writableState.finished || output._writableState.destroyed) && Promise.reject(Error(
      'wrong output state'
    )) ||
    (!headers[':status'] || !headers['content-type']) && Promise.reject(Error(
      'wrong respond headers'
    )) ||
    output.headersSent && Promise.reject(Error(
      'headers already sent'
    )) ||
    Promise.resolve((
      output.respond(headers), output
    ))
})

const responseblock = content => ({
  sendBody: output =>
    output.aborted && Promise.reject(Error(
      `aborted and destroyed`
    )) ||
    output
    .end(content),
})

const responseerror = (status, content) => ({
  ...responseheaders({
    ':status': status,
    'content-type': 'text/plain;charset=utf-8'
  }),
  ...responseblock(content)
})

const RESPONSEEXCUSE = (error, action, URL) =>
  error.code === 'ENOENT' && responseerror(
    404, `${error.name}: no such file or directory, ${action}: ${URL.pathname}.`
  ) ||
  responseerror(
    500, `${error.name}: ${error.message}, ${action}: ${URL.pathname}.`
  )

const RESPONSEREDIRECT = (content, location) => ({
  ...responseheaders({
    ':status': 301,
    'content-type': 'text/plain;charset=utf-8',
    'location': location
  }),
  ...responseblock(content)
})

const RESPONSESTREAM = (type, encoding, source) => ({
  ...responseheaders({
    ':status': 200,
    'content-type': type,
    'content-encoding': encoding
  }),
  sendBody: output =>
    output.aborted && Promise.reject(Error(
      `aborted and destroyed`
    )) ||
    Promise.resolve(
      source.pipe(output)
    ),
})

////////////////////////////////////////////////////////////////////////////////

const RESPOND = (output, response) =>
  response
  .sendHead(output)
  .then(output =>
    response
    .sendBody(output)
  )

////////////////////////////////////////////////////////////////////////////////

const transit = () =>
  new Transform({
    transform: (chunk, encoding, callback) =>
      setImmediate(callback, null, chunk)
  })

const encoder = {
  'br': () => STREAMWRAP(zlib.createBrotliCompress(), 'brotli encoding'),
  'gzip': () => STREAMWRAP(zlib.createGzip(), 'gzip encoding'),
  'deflate': () => STREAMWRAP(zlib.createDeflate(), 'deflate encoding'),
  'undefined': () => STREAMWRAP(transit(), 'transit')
}

const testfile = location =>
  fs.promises.stat(location)
  .then(stat =>
    stat.isFile() && Promise.resolve(
      location
    ) ||
    stat.isDirectory() && Promise.reject(
      Object.assign(Error(
        'DIRNOTFILE: illegal operation'
      ), {
        code: 'DIRNOTFILE'
      })
    ) ||
    Promise.reject(Error(
      'illegal operation'
    ))
  )

const sourcestream = (location, encodingHeader) =>
  sourcestream[location] ||
  (
    sourcestream[location] =
    testfile(location)
    .then(location =>
      fs.promises.open(location)
    )
    .then(fh =>
      STREAMWRAP(fh.createReadStream({ autoClose: true, emitClose: true }), 'source')
      .on('ready', () => delete sourcestream[location])
      .on('error', () => delete sourcestream[location])

    )
    .then(source => [
      `${mime.getType(location) || '*/*'}; charset=utf-8`,
      encodingHeader.includes('br') && 'br' ||
      encodingHeader.includes('gzip') && 'gzip' ||
      encodingHeader.includes('deflate') && 'deflate' ||
      'undefined',
      source
      .pipe(encoder[encoding]())
    ])
  )

const RESPONDFILE = (output, URL, location, acceptHeader, encodingHeader) =>
  sourcestream(location, encodingHeader)
  .then(([mimetype, encoding, source]) => RESPOND(
    output,
    RESPONSESTREAM(mimetype, encoding, source)
  ))
  .catch(error => RESPOND(
    output,
    error.code === 'DIRNOTFILE' && RESPONSEREDIRECT(
      `${error.name}: not a file, open: ${URL.pathname}.`,
      (URL.pathname = URL.pathname.concat('/'), URL.format())
    ) ||
    RESPONSEEXCUSE(error, 'open', URL)
  ))
////////////////////////////////////////////////////////////////////////////////

const acceptables = acceptHeader =>
  acceptHeader.split(',')
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
  fs.promises.stat(location)
  .then(stat =>
    stat.isDirectory() && Promise.resolve(
      location
    ) ||
    stat.isFile() && Promise.reject(
      Object.assign(Error(
        'FILENOTDIR: illegal operation'
      ), {
        code: 'FILENOTDIR'
      })
    ) ||
    Promise.reject(Error(
      'illegal operation'
    ))
  )

const sourcefile = (acceptHeader, location) =>
  testdir(location)
  .then(location =>
    fs.promises.readdir(location, 'utf8')
  )
  .then(availables =>
    acceptables(acceptHeader).find(
      acceptable =>
      availables.find(
        available =>
        acceptable === available
      )
    ) ||
    Promise.reject(Error(
      'no match file'
    ))
  )

const RESPONDDIR = (output, URL, location, acceptHeader, encodingHeader) =>
  sourcefile(acceptHeader, location)
  .then(filename => RESPONDFILE(
    output,
    (URL.pathname += filename, URL),
    path.join(location, filename),
    acceptHeader,
    encodingHeader
  ))
  .catch(error => RESPOND(
    output,
    error.code === 'FILENOTDIR' && RESPONSEREDIRECT(
      `${error.name}: not a directory, scandir: ${URL.pathname}`,
      ((URL.pathname = URL.pathname.slice(0, -1)), URL.format())
    ) ||
    RESPONSEEXCUSE(error, 'scan', URL)
  ))

////////////////////////////////////////////////////////////////////////////////

const SELFSIGNED = hostnames =>
  Promise.resolve(forge.pki.rsa.generateKeyPair(2048))
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
      `${mapSignname(hostnames.join('-') || 'default')}.${name}.pem`
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
      mapHostname(hostname, '')
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

const create = (hostnames, mapHostname, mapSignname, port) => (
  log('Server starting.'),
  Promise.all([
    TOUCHROOTS(hostnames, mapHostname),
    TOUCHSIGNS(hostnames, mapSignname)
  ])
  .then(([paths, [certificate, privateKey, publicKey]]) =>
    http2.createSecureServer({
      key: privateKey,
      cert: certificate
    })
    .listen(port)
  )
  .then(server => (
    log('Server started.'),
    server
  ))
)

const getidentifier = headers =>
  (
    headers[':method'] !== 'GET' ||
    !headers[':scheme'] ||
    !headers[':authority'] ||
    !headers[':path']
  ) &&
  Promise.reject(Error(
    'wrong request'
  )) ||
  Promise.resolve(url.parse(
    `${headers[':scheme']}://${headers[':authority']}${headers[':path']}`
  ))

const getlocation = (URL, hostnames, mapHostname, mapPathname) =>
  Promise.all(
    Object.entries({
      hostname: url.domainToUnicode(URL.hostname),
      pathname: path.normalize(URL.pathname)
    })
    .map(([key, value]) =>
      (!value || !value.length) &&
      Promise.reject(Error(
        `empty ${key}`
      )) ||
      Promise.resolve(value)
    )
  )
  .then(([hostname, pathname]) =>
    !(hostnames.length === 0 || hostnames.includes(hostname)) &&
    Promise.reject(Error(
      'wrong hostname'
    )) ||
    Promise.resolve(
      path.join(
        mapHostname(hostname, pathname),
        mapPathname(pathname, hostname)
      ) ||
      ''
    )
  )

const answer = (hostnames, mapHostname, mapPathname, output, headers) =>
  getidentifier(headers)
  .then(URL =>
    getlocation(
      URL,
      hostnames,
      mapHostname,
      mapPathname
    )
    .then(location =>
      (location.slice(-1) === path.sep && RESPONDDIR || RESPONDFILE)(
        STREAMWRAP(output, 'output')
        .on('aborted', () =>
          output.destroy(Error(
            `aborted and destroyed`
          ))
        ),
        URL,
        location,
        headers['accept'] || '',
        headers['accept-encoding'] || ''
      )
    )
  )
  .catch(error => error && RESPOND(
      output,
      RESPONSEEXCUSE(error, `wrong request`, {})
  ))

const INDEX = ({
    hostnames = ['localhost'],
    mapHostname = noop,
    mapSignname = noop,
    mapPathname = noop,
    port = 443
  }) =>
  create(
    hostnames,
    mapHostname,
    mapSignname,
    port
  )
  .then(server =>
    server
    .on('stream', (output, headers) =>
      answer(
        hostnames,
        mapHostname,
        mapPathname,
        output,
        headers
      )
    )
  )

INDEX.create = create
INDEX.answer = answer

export default INDEX
