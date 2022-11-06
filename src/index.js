import stream from 'stream'
import http2 from 'http2'
import url from 'url'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'

import mime from 'mime'
import punycode from 'punycode'
import forge from 'node-forge'

const mute = true

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
  sendHead: stream =>
    (stream._writableState.finished || stream._writableState.destroyed) && Promise.reject(Error(
      'wrong output state'
    )) ||
    (!headers[':status'] || !headers['content-type']) && Promise.reject(Error(
      'wrong respond headers'
    )) ||
    stream.headersSent && Promise.reject(Error(
      'headers already sent'
    )) ||
    Promise.resolve((
      stream.respond(headers),
      stream
    ))
})

const responseblock = content => ({
  sendBody: stream =>
    stream
    .end(content),
  reject: (stream, error) =>
    stream
    .destroy(error)
})

const responseerror = (status, content) => ({
  ...responseheaders({
    ':status': status,
    'content-type': 'text/plain;charset=utf-8'
  }),
  ...responseblock(content)
})

const RESPONSEEXCUSE = (error, action, URI) =>
  error.code === 'ENOENT' && responseerror(
    404, `${error.name}: no such file or directory, ${action}: ${URI.pathname}.`
  ) ||
  responseerror(
    500, `${error.name}: ${error.message}, ${action}: ${URI.pathname}.`
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
  sendBody: stream =>
    stream.aborted && Promise.reject(Error(
      `aborted and destroyed`
    )) ||
    Promise.resolve(
      source.pipe(stream)
      .on('aborted', () =>
        stream.destroy(Error(
          `aborted and destroyed`
        ))
      )
    ),
  reject: (stream, error) => (
    source
    .destroy(error),
    stream
    .destroy(error)
  )
})

////////////////////////////////////////////////////////////////////////////////

const RESPOND = (stream, response) =>
  response
  .sendHead(stream)
  .then(stream =>
    response
    .sendBody(stream)
  )
  .catch(error =>
    response
    .reject(stream, error)
  )

////////////////////////////////////////////////////////////////////////////////

const transit = () =>
  new stream.Transform({
    transform: (chunk, encoding, callback) =>
      setImmediate(callback, null, chunk)
  })

const mimetype = location =>
  `${mime.getType(location) || '*/*'}; charset=utf-8`

const encoding = encodingHeader =>
  encodingHeader.includes('br') && 'br' ||
  encodingHeader.includes('gzip') && 'gzip' ||
  encodingHeader.includes('deflate') && 'deflate' ||
  'undefined'

const encoder = {
  'br': () => STREAMWRAP(zlib.createBrotliCompress(), 'brotli encoding'),
  'gzip': () => STREAMWRAP(zlib.createGzip(), 'gzip encoding'),
  'deflate': () => STREAMWRAP(zlib.createDeflate(), 'deflate encoding'),
  'undefined': () => STREAMWRAP(transit(), 'transit')
}

const testfile = source =>
  new Promise((resolve, reject) =>
    source
    .on('error', error =>
      reject(error)
    )
    .on('open', fd =>
      fs.fstat(fd, (error, stat) =>
        error && reject(error) ||
        resolve(stat)
      )
    )
  )
  .then(stat =>
    stat.isFile() && Promise.resolve(
      source
    ) ||
    stat.isDirectory() && Promise.reject(
      Object.assign(Error(
        'EISDIR: illegal operation on a directory'
      ), {
        code: 'EISDIR'
      })
    ) ||
    Promise.reject(Error(
      'illegal operationonan item'
    ))
  )

const getsource = (location, acceptHeader, encodingHeader) =>
  getsource[location] ||
  (
    getsource[location] =
    testfile(
      fs.createReadStream(location, {
        autoClose: true,
        emitClose: true
      })
      .on('ready', () => delete getsource[location])
      .on('error', () => delete getsource[location])
    )
    .then(source => [
      mimetype(location),
      encoding(encodingHeader),
      source
    ])
    .then(([mimetype, encoding, source]) => [
      mimetype,
      encoding,
      STREAMWRAP(source, 'source')
      .pipe(STREAMWRAP(transit(), 'source transit'))
      .pipe(encoder[encoding]())
      .pipe(STREAMWRAP(transit(), 'output transit'))
    ])
  )

const RESPONDFILE = (stream, URI, location, acceptHeader, encodingHeader) =>
  getsource(location, acceptHeader, encodingHeader)
  .then(([mimetype, encoding, source]) =>
    RESPOND(stream, RESPONSESTREAM(mimetype, encoding, source))
  )
  .catch(error =>
    RESPOND(stream,
      error.code === 'EISDIR' && RESPONSEREDIRECT(
        `${error.name}: not a file, open: ${URI.pathname}.`,
        (URI.pathname = URI.pathname.concat('/'), URI.format())
      ) ||
      RESPONSEEXCUSE(error, 'open', URI)
    )
  )
////////////////////////////////////////////////////////////////////////////////

const acceptable = acceptHeader =>
  acceptHeader.split(',')
  .map((acceptItem, itemPosition, parentArray) =>
    acceptItem
    .match(/^\s*((?:[a-z]+|\*)\/(?:(?:[a-z0-9]+)(?:[+\-.][a-z0-9]+)*|\*))(?:;q=([01](?:\.\d+)?))?\s*$/s)
  )
  .map((acceptMatch, itemPosition, parentArray) => ({
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
  ) || Promise.reject(Error(
    'accept is empty'
  ))

const available = location =>
  fs.promises.readdir(location, 'utf8')
  .then(filenames =>
    filenames || Promise.reject(Error(
      'directory is empty'
    ))
  )

const RESPONDDIR = (stream, URI, location, acceptHeader, encodingHeader) =>
  Promise.all([
    acceptable(acceptHeader),
    available(location)
  ])
  .then(([acceptables, availables]) =>
    acceptables.find(
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
  .then(filename =>
    RESPONDFILE(
      stream,
      ((URI.pathname = URI.pathname.concat(filename)), URI),
      path.join(location, filename),
      acceptHeader,
      encodingHeader
    )
  )
  .catch(error =>
    RESPOND(stream,
      error.code === 'ENOTDIR' && RESPONSEREDIRECT(
        `${error.name}: not a directory, scandir: ${URI.pathname}`,
        ((URI.pathname = URI.pathname.slice(0, -1)), URI.format())
      ) ||
      RESPONSEEXCUSE(error, 'scan', URI)
    )
  )

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
      `${(mapSignname || noop)(hostnames.join('-') || 'default')}.${name}.pem`
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
        'Warning: certificate or one or more of keys were not loaded, selfsigned will be generated.'
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
            'Warning: selfsigned has been generated, certificate or one or more of keys were not saved.'
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
      (mapHostname || noop)(hostname, '')
    )
    .map((pathname) =>
      fs.promises.open(
        pathname,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY
      )
      .then(fh =>
        fh.close()
      )
      .catch(error => (
        log(
          `Warning: source path '${pathname}' not found, empty will be created.`
        ),
        fs.promises.mkdir(pathname)
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
    TOUCHROOTS(hostnames || [], mapHostname || noop),
    TOUCHSIGNS(hostnames || '', mapSignname || noop)
  ])
  .then(([paths, [certificate, privateKey, publicKey]]) =>
    http2.createSecureServer({
      key: privateKey,
      cert: certificate
    })
    .listen(port || 443)
  )
  .then(server => (
    log('Server started.'),
    server
  ))
)

const getidentifier = headers =>
  headers[':method'] !== 'GET' && Promise.reject(
    null
  ) ||
  (!headers[':scheme'] || !headers[':authority'] || !headers[':path']) && Promise.reject(Error(
    'wrong URI'
  )) ||
  Promise.resolve(
    url.parse(`${headers[':scheme']}://${headers[':authority']}${headers[':path']}`)
  )

const getlocation = (URI, hostnames, mapHostname, mapPathname) =>
  Promise.all(
    Object.entries({
      hostname: path.normalize(punycode.toUnicode(URI.hostname)),
      pathname: path.normalize(decodeURIComponent(URI.pathname))
    })
    .map(([key, value]) =>
      (!value || !value.length) && Promise.reject(Error(
        `empty ${key}`
      )) ||
      Promise.resolve(value)
    )
  )
  .then(([hostname, pathname]) =>
    !(hostnames.length === 0 || hostnames.includes(hostname)) && Promise.reject(Error(
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

const answer = (hostnames, mapHostname, mapPathname, stream, headers) =>
  getidentifier(headers)
  .then(URI =>
    getlocation(
      URI,
      hostnames || '',
      mapHostname || noop,
      mapPathname || noop
    )
    .then(location =>
      (location.slice(-1) === path.sep && RESPONDDIR || RESPONDFILE)(
        STREAMWRAP(stream, 'output'),
        URI,
        location,
        headers['accept'] || '',
        headers['accept-encoding'] || ''
      )
    )
  )
  .catch(error =>
    error && RESPOND(
      stream,
      RESPONSEEXCUSE(error, `wrong request`, {})
    )
  )

const INDEX = ({
    hostnames = [],
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
    .on('stream', (stream, headers) =>
      answer(
        hostnames,
        mapHostname,
        mapPathname,
        stream,
        headers
      )
    )
  )

INDEX.create = create
INDEX.answer = answer

export default INDEX
