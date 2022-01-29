/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import {getConfig} from './utils'

/**
 * Return all the permutations of routes with site id/alias and locale id/alias
 *
 * @param {array} routes - array of routes to be configured
 * @param {object} - a custom configured object
 * @return {array} - list of configured route objects
 */
export const configureRoutes = (routes = [], {ignoredRoutes = []}) => {
    if (!routes.length) return []

    const hosts = getConfig('app.routing.hosts')
    const currentHost = getCurrentHost()

    // collect and flatten the result to get a list of site objects
    const allSites = hosts.find((host) => host.domain.includes(currentHost))?.siteMaps

    // get a collection of all site-id and site alias from the config of the current host
    // remove any duplicates
    const sites = [
        ...new Set(
            allSites
                ?.reduce((res, site) => {
                    return [...res, site.id, site.alias]
                }, [])
                .filter(Boolean)
        )
    ]
    // get a collection of all locale-id and locale alias from the config of the current host
    // remove any duplicates by using [...new Set([])]
    const locales = [
        ...new Set(
            allSites
                .reduce((res, {id}) => {
                    const supportedLocales = getConfig(`app.sites.${id}.supportedLocales`)
                    supportedLocales.forEach((locale) => {
                        res = [...res, locale.id, locale.alias]
                    })
                    return res
                }, [])
                .filter(Boolean)
        )
    ]

    let outputRoutes = []
    for (let i = 0; i < routes.length; i++) {
        const {path, ...rest} = routes[i]
        if (ignoredRoutes.includes(path)) {
            outputRoutes.push(routes[i])
        } else {
            // construct all the routes that has both site and locale
            sites.forEach((site) => {
                locales.forEach((locale) => {
                    const newRoute = `/${site}/${locale}${path}`
                    outputRoutes.push({
                        path: newRoute,
                        ...rest
                    })
                })
            })

            // construct the routes that only has site id or alias
            sites.forEach((site) => {
                outputRoutes.push({
                    path: `/${site}${path}`,
                    ...rest
                })
            })

            // construct the routes that only has locale id or alias
            locales.forEach((locale) => {
                outputRoutes.push({
                    path: `/${locale}${path}`,
                    ...rest
                })
            })
            // origin route will be at the bottom
            outputRoutes.push(routes[i])
        }
    }

    return outputRoutes
}

/**
 * This function return the current host by looking in the EXTERNAL_DOMAIN_NAME env variable
 * if it is undefined, it means you are on localhost
 * @returns {string}
 */
const getCurrentHost = () => {
    if (typeof window !== 'undefined') {
        return window.location.hostname
    }

    const currentHost = process.env.EXTERNAL_DOMAIN_NAME
        ? process.env.EXTERNAL_DOMAIN_NAME
        : 'localhost'

    return currentHost
}
