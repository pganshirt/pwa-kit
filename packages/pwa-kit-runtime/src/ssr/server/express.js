/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
/**
 * @module progressive-web-sdk/ssr/server/express
 */

import path from 'path'
import URL from 'url'
import {
    CachedResponse,
    getHashForString,
    getBundleBaseUrl,
    localDevLog,
    parseCacheControl,
    parseEndParameters,
    isRemote,
    wrapResponseWrite,
    detectDeviceType
} from '../../utils/ssr-server'
import {CACHE_CONTROL, CONTENT_ENCODING, X_MOBIFY_FROM_CACHE} from './constants'
import {X_MOBIFY_REQUEST_CLASS} from '../../utils/ssr-proxying'
import {RemoteServerFactory} from './build-remote-server'

export const RESOLVED_PROMISE = Promise.resolve()

/**
 * Use properties of the request, such as URL and querystring, to generate
 * a cache key string suitable for passing to sendResponseFromCache or
 * storeResponseInCache.
 *
 * This method is provided as a convenience: you do not have to use it,
 * but it should cover the most common use cases. It is the default
 * cache key generator used by sendResponseFromCache and
 * storeResponseInCache. If you override the cache key function
 * in the options for storeResponseInCache, you may call this function
 * and then further modify the returned key.
 *
 * The cache key is based on the request's path (case-independent) and
 * querystring (case-dependent). The order of parameters in the querystring
 * is important: if the order changes, the cache key changes. This is done
 * because the order of query parameters is important for some systems.
 *
 * To allow for simple extension of the default algorithm, the optional
 * 'options.extras' parameter may be used to pass an array of strings that
 * will also be used (in the order they are passed) to build the key.
 * Undefined values are allowed in the extras array.
 *
 * By default, the key generation does NOT consider the Accept,
 * Accept-Charset or Accept-Language request header values. If it's
 * appropriate to include these, the caller should add their values
 * (or values based on them) to the options.extras array.
 *
 * Requests that come to a deployed Express app contain headers that
 * identify the device type. By default, this method generates different
 * cache keys for different device types (effectively, the values of the
 * headers used by getBrowserSize are included in 'options.extras'). To
 * suppress this, pass true for options.ignoreDeviceType
 * Note: CloudFront will pass 4 device type headers, and ALL of them will
 * be present in the request headers, they are 'CloudFront-Is-Desktop-Viewer',
 * 'CloudFront-Is-Mobile-Viewer', 'CloudFront-Is-SmartTV-Viewer' and
 * 'CloudFront-Is-Tablet-Viewer'. The values can be 'true' or 'false', and it
 * is possible that a device falls into more than one device type category
 * and multiple device type headers can be 'true' at the same time.
 *
 * By default, method will generate different cache keys for requests with
 * different request classes (effectively, the value of the request-class
 * string is included in 'extras'). To suppress this, pass true for
 * options.ignoreRequestClass
 *
 * @param req {IncomingMessage} the request to generate the key for.
 * @param [options] {Object} values that affect the cache key generation.
 * @param [options.extras] {Array<String|undefined>} extra string values
 * to be included in the key.
 * @param [options.ignoreDeviceType] {Boolean} set this to true to suppress
 * automatic variation of the key by device type.
 * @param [options.ignoreRequestClass] {Boolean} set this to true to suppress
 * automatic variation of the key by request class.
 * @returns {String} the generated key.
 *
 * @private
 */
export const generateCacheKey = (req, options = {}) => {
    let {pathname, query} = URL.parse(req.url)

    // remove the trailing slash
    if (pathname.charAt(pathname.length - 1) === '/') {
        pathname = pathname.substring(0, pathname.length - 1)
    }

    const elements = []

    if (query) {
        const filteredQueryStrings = query
            .split('&')
            .filter((querystring) => !/^mobify_devicetype=/.test(querystring))
        elements.push(...filteredQueryStrings)
    }

    if (!options.ignoreDeviceType) {
        elements.push(`device=${detectDeviceType(req)}`)
    }

    if (!options.ignoreRequestClass) {
        const requestClass = req.get(X_MOBIFY_REQUEST_CLASS)
        if (requestClass) {
            elements.push(`class=${requestClass}`)
        }
    }

    if (options.extras) {
        options.extras.forEach((extra, index) => elements.push(`ex${index}=${extra}`))
    }

    return pathname.toLowerCase() + '/' + getHashForString(elements.join('-'))
}

/**
 * Internal handler that is called on completion of a response
 * that is to be cached.
 *
 * @param req {http.IncomingMessage} the request
 * @param res {http.ServerResponse} the response
 * @returns {Promise} resolved when caching is done (also
 * stored in locals.responseCaching.promise
 * @private
 */
const storeResponseInCache = (req, res) => {
    const locals = res.locals
    const caching = locals.responseCaching

    const metadata = {
        status: res.statusCode,
        headers: res.getHeaders()
    }

    // ADN-118 When the response is created, we intercept the data
    // as it's written, and store it so that we can cache it here.
    // However, ExpressJS will apply compression *after* we store
    // the data, but will add a content-encoding header *before*
    // this method is called. If we store the headers unchanged,
    // we'll cache a response with an uncompressed body, but
    // a content-encoding header. We therefore remove the content-
    // encoding at this point, so that the response is stored
    // in a consistent way.
    // The exception is if the contentEncodingSet flag is set on
    // the response. If it's truthy, then project code set a
    // content-encoding before the Express compression code was
    // called; in that case, we must leave the content-encoding
    // unchanged.
    if (!locals.contentEncodingSet) {
        delete metadata.headers[CONTENT_ENCODING]
    }

    const cacheControl = parseCacheControl(res.get('cache-control'))
    const expiration = parseInt(
        caching.expiration || cacheControl['s-maxage'] || cacheControl['max-age'] || 7 * 24 * 3600
    )

    // Return a Promise that will be resolved when caching is complete.
    let dataToCache
    /* istanbul ignore else */
    if (caching.chunks.length) {
        // Concat the body into a single buffer.\
        // caching.chunks will be an Array of Buffer
        // values, and may be empty.
        dataToCache = Buffer.concat(caching.chunks)
    }
    return (
        req.app.applicationCache
            .put({
                key: caching.cacheKey,
                namespace: caching.cacheNamespace,
                data: dataToCache,
                metadata,
                expiration: expiration * 1000 // in mS
            })
            // If an error occurs,we don't want to prevent the
            // response being sent, so we just log.
            .catch((err) => {
                console.warn(`Unexpected error in cache put: ${err}`)
            })
    )
}

/**
 * Configure a response so that it will be cached when it has been sent.
 * Caching ExpressJS responses requires intercepting of all the header
 * and body setting calls on it, which may occur at any point in the
 * response lifecycle, so this call must be made before the response
 * is generated.
 *
 * If no key is provided, it's generated by generateCacheKey.
 * Project code may call generateCacheKey with extra options to affect
 * the key, or may use custom key generation logic. If code has
 * previously called getResponseFromCache, the key and namespace are
 * available as properties on the CachedResponse instance returned
 * from that method.
 *
 * When caching response, the cache expiration time is set by
 * the expiration parameter. The cache expiration time may be
 * different to the response expiration time as set by the cache-control
 * header. See the documentation for the 'expiration' parameter for
 * details.
 *
 * @param req {express.request}
 * @param res {express.response}
 * @param [expiration] {Number} the number of seconds
 * that a cached response should persist in the cache. If this is
 * not provided, then the expiration time is taken from the
 * Cache-Control header; the s-maxage value is used if available,
 * then the max-age value. If no value can be found in the
 * Cache-Control header, the default expiration time is
 * one week.
 * @param [key] {String} the key to use - if this is not supplied,
 * generateCacheKey will be called to derive the key.
 * @param [namespace] {String|undefined} the cache namespace to use.
 * @param [shouldCacheResponse] {Function} an optional callback that is passed a
 * Response after it has been sent but immediately before it is stored in
 * the cache, and can control whether or not caching actually takes place.
 * The function takes the request and response as parameters and should
 * return true if the response should be cached, false if not.
 * @private
 */
export const cacheResponseWhenDone = ({
    req,
    res,
    expiration,
    key,
    namespace,
    shouldCacheResponse
}) => {
    const locals = res.locals
    const caching = locals.responseCaching

    // If we have a key passed in, use that.
    // If we have a key already generated by getResponseFromCache, use that.
    // Otherwise generate the key from the request
    /* istanbul ignore next */
    caching.cacheKey = key || caching.cacheKey || generateCacheKey(req)

    // Save values that will be needed when we store the response
    caching.cacheNamespace = namespace
    caching.expiration = expiration

    // Set a flag that we use to detect a double call to end().
    // Because we delay the actual call to end() until after
    // caching is complete, we also delay when the response's 'finished'
    // flag becomes true, and when the 'finished' event is emitted.
    // This means that code may call end() more than once. We need
    // to ignore any second call.
    caching.endCalled = false

    /*
     Headers can be retrieved at any point, so there's no need to
     intercept them. They're still present after the response ends
     (contrary to some StackOverflow responses).
     The response body can be sent in multiple chunks, at any time,
     so we need a way to store references to those chunks so that
     we can access the whole body to store it in the cache.
     We patch the write() method on the response (which is a subclass of
     node's ServerResponse, implementing the stream.Writeable interface)
     and record the chunks as they are sent.
     */
    wrapResponseWrite(res)

    /*
     Patch the end() method of the response to call _storeResponseInCache.
     We use this patching method instead of firing on the 'finished' event
     because we want to guarantee that caching is complete before we
     send the event. If we use the event, then caching may happen after
     the event is complete, but in a Lambda environment processing is
     halted once the event is sent, so caching might not occur.
     */
    const originalEnd = res.end
    res.end = (...params) => {
        // Check the cached flag - in some cases, end() may be
        // called twice and we want to ignore the second call.
        if (caching.endCalled) {
            return
        }
        caching.endCalled = true

        // Handle any data writing that must be done before end()
        // is called.
        const {data, encoding, callback} = parseEndParameters(params)
        if (data) {
            // We ignore the return value from write(), because we
            // don't care whether the data is queued in user memory
            // or is accepted by the OS, as long as we call write()
            // before we call end()
            res.write(data, encoding)
        }

        // The response has been sent. If there is a shouldCacheResponse
        // callback, we call it to decide whether to cache or not.
        if (shouldCacheResponse) {
            if (!shouldCacheResponse(req, res)) {
                localDevLog(`Req ${locals.requestId}: not caching response for ${req.url}`)
                return originalEnd.call(res, callback)
            }
        }

        // We know that all the data has been written, so we
        // can now store the response in the cache and call
        // end() on it.
        const timer = res.locals.timer
        req.app.applicationCache._cacheDeletePromise
            .then(() => {
                localDevLog(`Req ${locals.requestId}: caching response for ${req.url}`)
                timer.start('cache-response')
                return storeResponseInCache(req, res).then(() => {
                    timer.end('cache-response')
                })
            })
            .finally(() => {
                originalEnd.call(res, callback)
            })
    }
}

/**
 * Given a CachedResponse that represents a response from the
 * cache, send it. Once this method has been called, the response
 * is sent and can no longer be modified. If this method is
 * called from the requestHook, the caller should return, and
 * should not call next()
 *
 * @param cached {CachedResponse} the cached response to send
 * @private
 */
export const sendCachedResponse = (cached) => {
    if (!(cached && cached.found)) {
        throw new Error(`Cannot send a non-cached CachedResponse`)
    }
    cached._send()
    cached._res.end()
}

/**
 * Look up a cached response for the given request in the persistent cache
 * and return a CachedResponse that represents what was found.
 *
 * This method would generally be called in the requestHook. The caller
 * should check the result of resolving the Promise returned by this
 * method. The returned object's 'found' property is true if a response
 * was found, 'false' if no response was found.
 *
 * The CachedResponse instance returned has details of any cached response
 * found, and project code can then choose whether to send it or not. For
 * example, the headers may be checked. To send that cached response, call
 * sendCachedResponse with it.
 *
 * If there is no cached response found, or the project code does not
 * choose to send it, then the code can also choose whether the
 * response generated by the server should be cached. If so, it
 * should call cacheResponseWhenDone.
 *
 * If no key is provided, it's generated by generateCacheKey.
 * Project code may call generateCacheKey with extra options to affect
 * the key, or may use custom key generation logic.
 *
 * By default, all cache entries occupy the same namespace, so responses
 * cached for a given URL/querystring/headers by one version of the UPWA
 * may be retrieved and used by other, later versions. If this is not
 * the required behaviour, the options parameter may be used to pass a
 * 'namespace' value. The same cache key may be used in different
 * namespaces to cache different responses. For example, passing the
 * bundle id as the namespace will result in each publish bundle starting
 * with a cache that is effectively per-bundle. The namespace value
 * may be any string, or an array of strings.
 *
 * @param req {express.request}
 * @param res {express.response}
 * @param [key] {String} the key to use - if this is not supplied,
 * generateCacheKey will be called to derive the key.
 * @param [namespace] {String|undefined} the cache namespace to use.
 * @returns {Promise<CachedResponse>} resolves to a CachedResponse
 * that represents the result of the cache lookup.
 * @private
 */
export const getResponseFromCache = ({req, res, namespace, key}) => {
    /* istanbul ignore next */
    const locals = res.locals
    const workingKey = key || generateCacheKey(req)

    // Save the key as the default for caching
    locals.responseCaching.cacheKey = workingKey

    // Return a Promise that handles the asynchronous cache lookup
    const timer = res.locals.timer
    timer.start('check-response-cache')
    return req.app.applicationCache.get({key: workingKey, namespace}).then((entry) => {
        timer.end('check-response-cache')

        localDevLog(
            `Req ${locals.requestId}: ${
                entry.found ? 'Found' : 'Did not find'
            } cached response for ${req.url}`
        )

        if (!entry.found) {
            res.setHeader(X_MOBIFY_FROM_CACHE, 'false')
        }

        return new CachedResponse({
            entry,
            req,
            res
        })
    })
}

/**
 * Serve static files from the app's build directory and set default
 * cache-control headers.
 * @since v2.1.0
 *
 * This is a wrapper around the Express `res.sendFile` method.
 *
 * @param {String} filePath - the location of the static file relative to the build directory
 * @param {Object} opts - the options object to pass to the original `sendFile` method
 */
export const serveStaticFile = (filePath, opts = {}) => {
    return (req, res) => {
        const options = req.app.options
        const file = path.resolve(options.buildDir, filePath)
        res.sendFile(file, {
            headers: {
                [CACHE_CONTROL]: options.defaultCacheControl
            },
            ...opts
        })
    }
}

/**
 * Provided for use by requestHook overrides.
 *
 * Call this to return a res that is a redirect to a bundle asset.
 * Be careful with res caching - 301 responses can be cached. You
 * can call res.set to set the 'Cache-Control' header before
 * calling this function.
 *
 * This function returns a Promise that resolves when the res
 * has been sent. The caller does not need to wait on this Promise.
 *
 * @param {Object} options
 * @param {Request} options.req - the ExpressJS request object
 * @param {Response} options.res - the ExpressJS res object
 * @param {String} [options.path] - the path to the bundle asset (relative
 * to the bundle root/build directory). If this is falsy, then
 * request.path is used (i.e. '/robots.txt' would be the path for
 * 'robots.txt' at the top level of the build directory).
 * @param {Number} [options.redirect] a 301 or 302 status code, which
 * will be used to respond with a redirect to the bundle asset.
 * @private
 */
export const respondFromBundle = ({req, res, path, redirect = 301}) => {
    // The path *may* start with a slash
    const workingPath = path || req.path

    // Validate redirect
    const workingRedirect = Number.parseInt(redirect)
    /* istanbul ignore next */
    if (workingRedirect < 301 || workingRedirect > 307) {
        throw new Error('The redirect parameter must be a number between 301 and 307 inclusive')
    }

    // assetPath will not start with a slash
    /* istanbul ignore next */
    const assetPath = workingPath.startsWith('/') ? workingPath.slice(1) : workingPath

    // This is the relative or absolute location of the asset via the
    // /mobify/bundle path
    const location = `${getBundleBaseUrl()}${assetPath}`

    localDevLog(
        `Req ${res.locals.requestId}: redirecting ${assetPath} to ${location} (${workingRedirect})`
    )
    res.redirect(workingRedirect, location)
}

export const getRuntime = () => {
    return isRemote()
        ? RemoteServerFactory
        : eval('require').main.require('pwa-kit-build/ssr/server/build-dev-server').DevServerFactory
}

/**
 * Render a pretty Salesforce-branded hello world.
 */
export const helloWorld = (req, res) => {
    res.send(`
        <html>
            <style>
                #salesforce-logo {position: absolute;left: 50%;top: 50%;transform: translate(-50%, -50%);}
                @keyframes float {
                    0% {transform: translatey(0px);}
                    50% {transform: translatey(-10px);}
                    100% {transform: translatey(0px);}
                }
                #salesforce-logo-content {transform: translateY(0);animation: float 2.5s ease-in-out infinite;}
            </style>
            <div id="salesforce-logo">
                <svg id="salesforce-logo-content" xmlns="http://www.w3.org/2000/svg" width="184" height="128" viewBox="0 0 92 64">
                    <g fill="none" fill-rule="evenodd">
                        <path fill="#00A1E0" d="M38.05 6.98c2.948-3.071 7.055-4.978 11.595-4.978 6.035 0 11.302 3.366 14.106 8.363a19.494 19.494 0 0 1 7.974-1.695c10.886 0 19.71 8.902 19.71 19.885 0 10.983-8.824 19.885-19.71 19.885-1.331 0-2.629-.133-3.884-.386-2.469 4.403-7.177 7.379-12.578 7.379-2.261 0-4.4-.52-6.303-1.451C46.456 59.872 40.623 64 33.826 64c-7.078 0-13.112-4.48-15.427-10.761a15.176 15.176 0 0 1-3.137.327C6.833 53.567 0 46.663 0 38.146a15.442 15.442 0 0 1 7.631-13.357 17.662 17.662 0 0 1-1.46-7.053C6.171 7.94 14.122 0 23.93 0a17.73 17.73 0 0 1 14.12 6.98"/>
                        <path fill="#FFF" d="M13.244 33.19l.37-1.027c.059-.176.192-.118.246-.085.103.061.177.116.31.194 1.09.689 2.1.696 2.415.696.816 0 1.322-.432 1.322-1.015v-.03c0-.634-.78-.874-1.681-1.15l-.2-.064c-1.237-.352-2.56-.861-2.56-2.427v-.032c0-1.486 1.199-2.523 2.915-2.523l.188-.002c1.008 0 1.982.293 2.688.721.064.04.126.114.09.212l-.38 1.027c-.067.175-.25.059-.25.059a5.41 5.41 0 0 0-2.382-.611c-.728 0-1.196.386-1.196.91v.033c0 .611.802.872 1.732 1.175l.16.05c1.233.39 2.549.93 2.549 2.415v.031c0 1.605-1.166 2.602-3.041 2.602-.921 0-1.802-.142-2.734-.637-.176-.102-.35-.19-.522-.315-.018-.026-.097-.057-.04-.207zm27.457 0l.371-1.027c.054-.168.211-.106.245-.085.102.063.178.116.31.194 1.092.689 2.1.696 2.418.696.813 0 1.32-.432 1.32-1.015v-.03c0-.634-.779-.874-1.68-1.15l-.2-.064c-1.239-.352-2.562-.861-2.562-2.427v-.032c0-1.486 1.2-2.523 2.916-2.523l.187-.002c1.008 0 1.983.293 2.69.721.062.04.125.114.09.212-.035.091-.347.931-.38 1.027-.069.175-.25.059-.25.059a5.41 5.41 0 0 0-2.383-.611c-.728 0-1.196.386-1.196.91v.033c0 .611.801.872 1.732 1.175l.16.05c1.233.39 2.548.93 2.548 2.415v.031c0 1.605-1.165 2.602-3.04 2.602-.922 0-1.803-.142-2.734-.637-.176-.102-.35-.19-.523-.315-.018-.026-.097-.057-.039-.207zm20.31-4.829c.154.516.23 1.083.23 1.682 0 .6-.076 1.165-.23 1.681a3.77 3.77 0 0 1-.71 1.361 3.384 3.384 0 0 1-1.204.906c-.48.22-1.044.33-1.678.33-.634 0-1.2-.11-1.678-.33a3.384 3.384 0 0 1-1.204-.906 3.793 3.793 0 0 1-.711-1.36 5.909 5.909 0 0 1-.23-1.682c0-.6.077-1.166.23-1.682.154-.52.393-.978.71-1.36a3.442 3.442 0 0 1 1.205-.914c.479-.224 1.042-.337 1.678-.337.636 0 1.199.113 1.678.337.478.223.884.53 1.204.914.318.382.558.84.71 1.36zm-1.564 1.682c0-.907-.168-1.62-.502-2.12-.33-.496-.83-.736-1.526-.736-.696 0-1.192.24-1.518.736-.327.5-.494 1.213-.494 2.12 0 .906.167 1.624.496 2.128.324.502.82.745 1.516.745.696 0 1.196-.244 1.526-.745.332-.504.502-1.222.502-2.128zm14.422 2.63l.384 1.062c.05.13-.063.187-.063.187-.593.23-1.416.394-2.217.394-1.358 0-2.398-.391-3.092-1.163-.69-.77-1.042-1.817-1.042-3.116 0-.601.087-1.17.257-1.685.17-.52.425-.978.761-1.36a3.613 3.613 0 0 1 1.261-.914c.5-.223 1.088-.335 1.744-.335.443 0 .837.027 1.175.077.361.056.842.186 1.045.265.037.014.14.064.098.185-.148.417-.249.689-.386 1.069-.06.162-.182.108-.182.108-.515-.162-1.009-.236-1.654-.236-.775 0-1.357.258-1.737.763-.384.509-.599 1.176-.602 2.063-.003.973.241 1.694.673 2.14.431.445 1.033.67 1.791.67.307 0 .597-.02.858-.061.258-.041.5-.121.728-.21 0 0 .147-.055.2.097zm8.01-4.607c.341 1.194.163 2.225.157 2.282-.013.136-.153.138-.153.138l-5.299-.004c.033.805.226 1.375.616 1.762.383.379.991.622 1.814.623 1.258.003 1.795-.25 2.176-.391 0 0 .145-.052.2.092l.345.971c.07.163.014.22-.045.253-.332.183-1.137.525-2.669.529-.743.003-1.39-.103-1.923-.31a3.502 3.502 0 0 1-1.333-.883 3.497 3.497 0 0 1-.769-1.347 5.713 5.713 0 0 1-.239-1.692c0-.6.077-1.17.232-1.691.155-.525.396-.988.717-1.377a3.479 3.479 0 0 1 1.221-.93c.486-.229 1.088-.341 1.75-.341.567 0 1.085.122 1.516.308.332.142.666.399 1.008.767.216.232.545.74.678 1.241zm-5.27 1.107h3.78c-.039-.486-.134-.922-.352-1.25-.332-.496-.79-.769-1.485-.769-.696 0-1.19.273-1.517.769-.214.328-.352.746-.427 1.25zm-37.175-1.107c.34 1.194.165 2.225.159 2.282-.014.136-.154.138-.154.138l-5.3-.004c.034.805.226 1.375.617 1.762.383.379.99.622 1.813.623 1.258.003 1.797-.25 2.177-.391 0 0 .145-.052.199.092l.346.971c.07.163.014.22-.044.253-.334.183-1.14.525-2.67.529-.744.003-1.391-.103-1.923-.31a3.514 3.514 0 0 1-1.334-.883 3.506 3.506 0 0 1-.767-1.347 5.68 5.68 0 0 1-.241-1.692c0-.6.078-1.17.232-1.691a3.88 3.88 0 0 1 .718-1.377 3.488 3.488 0 0 1 1.22-.93c.488-.229 1.09-.341 1.75-.341a3.85 3.85 0 0 1 1.518.308c.332.142.666.399 1.007.767.216.232.545.74.677 1.241zm-5.271 1.107h3.782c-.04-.486-.135-.922-.352-1.25-.33-.496-.79-.769-1.485-.769-.696 0-1.191.273-1.516.769-.216.328-.353.746-.43 1.25zm-9.346-.253s.418.037.874.103v-.224c0-.707-.147-1.04-.436-1.263-.296-.226-.738-.343-1.31-.343 0 0-1.29-.016-2.31.538-.047.028-.086.044-.086.044s-.128.045-.174-.086L21 26.681c-.058-.145.047-.211.047-.211.477-.372 1.633-.597 1.633-.597a8.711 8.711 0 0 1 1.421-.131c1.058 0 1.877.246 2.434.733.558.489.842 1.277.842 2.339l.003 4.848s.011.14-.122.172c0 0-.195.054-.37.095-.177.041-.815.171-1.336.259a9.744 9.744 0 0 1-1.61.134c-.515 0-.987-.048-1.403-.143a2.92 2.92 0 0 1-1.079-.468 2.192 2.192 0 0 1-.69-.829c-.163-.333-.245-.74-.245-1.21 0-.461.097-.872.284-1.222.188-.348.446-.643.77-.874a3.425 3.425 0 0 1 1.105-.513c.413-.11.852-.167 1.306-.167.333 0 .611.007.827.024zm-2.109 3.724c-.003-.001.475.375 1.554.309.758-.046 1.43-.19 1.43-.19v-2.41s-.678-.111-1.439-.122c-1.079-.013-1.539.384-1.536.383-.318.226-.473.561-.473 1.025 0 .297.053.529.16.691.067.107.096.147.304.314zm44.855-6.455c-.05.145-.307.871-.4 1.112-.034.092-.09.155-.193.144 0 0-.304-.07-.582-.07-.191 0-.464.024-.71.1a1.586 1.586 0 0 0-.654.393c-.194.187-.351.45-.465.78-.116.332-.176.86-.176 1.39v3.948a.16.16 0 0 1-.16.161h-1.391a.162.162 0 0 1-.164-.16v-7.905c0-.089.065-.16.154-.16h1.357c.09 0 .154.071.154.16v.646c.203-.272.567-.512.896-.66.33-.15.699-.26 1.366-.22.347.021.798.116.889.151a.144.144 0 0 1 .079.19zm-13.07-3.663c.037.015.138.064.098.184l-.407 1.113c-.034.084-.056.134-.229.082a2.388 2.388 0 0 0-.707-.11c-.21 0-.4.027-.568.083a1.084 1.084 0 0 0-.444.274 1.545 1.545 0 0 0-.372.566c-.195.56-.27 1.157-.28 1.195h1.694c.143 0 .188.066.174.171l-.198 1.102c-.032.16-.177.154-.177.154h-1.746l-1.193 6.756a10.426 10.426 0 0 1-.466 1.78c-.187.489-.38.846-.69 1.187a2.43 2.43 0 0 1-.979.682c-.367.135-.813.204-1.3.204-.232 0-.482-.005-.777-.075a4.198 4.198 0 0 1-.485-.142c-.065-.023-.118-.106-.08-.212.036-.105.35-.964.392-1.077.054-.136.192-.084.192-.084.094.04.16.066.285.091.127.025.297.047.426.047.231 0 .441-.028.624-.09.22-.071.35-.2.484-.372.14-.181.254-.426.371-.755.117-.333.224-.773.316-1.306l1.188-6.633h-1.17c-.14 0-.188-.066-.172-.172l.196-1.102c.031-.16.18-.154.18-.154h1.201l.065-.358c.18-1.064.537-1.873 1.065-2.404.531-.535 1.286-.805 2.244-.805.274 0 .516.018.721.055.201.038.354.073.524.125zM30.817 33.986c0 .09-.062.161-.152.161H29.26c-.09 0-.151-.072-.151-.16V22.674c0-.087.062-.159.15-.159h1.406c.09 0 .152.072.152.16v11.311z"/>
                    </g>
                </svg>
            </div>
        </html>
    `)
}
