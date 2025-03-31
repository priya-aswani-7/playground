const proxy = require('koa-proxies');
const URL = require('url').URL;
const cors = require('@koa/cors');

const validateUrl = (url) => {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch (error) {
    return false;
  }
};

const handler = async (ctx, next) => {
  if (ctx.method !== 'GET') {
    ctx.status = 405;
    ctx.body = { status: 'error', message: 'Only GET requests are allowed.' };
    return;
  }

  const targetUrl = ctx.query.url;

  if (!targetUrl || !validateUrl(targetUrl)) {
    ctx.status = 400;
    ctx.body = { status: 'error', message: 'Invalid URL.' };
    return;
  }

  const targetUrlObj = new URL(targetUrl);
  const baseUrl = `${targetUrlObj.protocol}//${targetUrlObj.host}`;
  const path = targetUrlObj.pathname + targetUrlObj.search;

  try {
    return proxy('/', {
      target: baseUrl,
      changeOrigin: true,
      logs: true,
      secure: false,
      followRedirects: true,
      timeout: 30000,
      ws: true,

      rewrite: (originalPath) => {
        return originalPath === '/' ? path || '/' : originalPath;
      },

      async onProxyReq(proxyReq, ctx) {
        proxyReq.setHeader('Accept-Encoding', 'gzip, deflate, br');
        proxyReq.setHeader(
          'User-Agent',
          ctx.get('User-Agent') || 'Mozilla/5.0',
        );
        proxyReq.setHeader('Referer', baseUrl);
        proxyReq.setHeader('Accept', '*/*');
      },

      async onProxyRes(proxyRes, ctx) {
        if (!proxyRes || !proxyRes.headers) {
          ctx.status = 502;
          ctx.body = {
            status: 'error',
            message: 'Bad Gateway - No response from target.',
          };
          return;
        }

        // Set permissive CORS headers to allow cross-origin requests
        ctx.set('Access-Control-Allow-Origin', '*');
        ctx.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, POST');
        ctx.set(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization, X-Requested-With',
        );
        ctx.set('Access-Control-Allow-Credentials', 'true');

        // Remove security headers that would prevent iframe loading or script execution
        [
          'x-frame-options',
          'content-security-policy',
          'permissions-policy',
          'strict-transport-security',
          'x-content-type-options',
          'feature-policy',
          'referrer-policy',
        ].forEach((header) => {
          if (proxyRes.headers[header]) {
            delete proxyRes.headers[header];
          }
        });

        // Add a very permissive Content Security Policy
        ctx.set(
          'Content-Security-Policy',
          "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
            "script-src * 'unsafe-inline' 'unsafe-eval'; " +
            "style-src * 'unsafe-inline'; " +
            'img-src * data: blob:; ' +
            'connect-src *; ' +
            'frame-ancestors *;',
        );

        const contentType = proxyRes.headers['content-type'] || '';
        const path = ctx.request.path;

        // Handle different content types appropriately
        if (path.match(/\.(png|jpg|jpeg|gif|webp|svg|ico)(\?.*)?$/i)) {
          const extension = path.split('.').pop().split('?')[0].toLowerCase();
          const mimeType =
            {
              png: 'image/png',
              jpg: 'image/jpeg',
              jpeg: 'image/jpeg',
              gif: 'image/gif',
              webp: 'image/webp',
              svg: 'image/svg+xml',
              ico: 'image/x-icon',
            }[extension] || 'image/png';

          ctx.set('Content-Type', mimeType);
          ctx.set('Cache-Control', 'public, max-age=86400, immutable');
        } else if (
          contentType.includes('application/json') &&
          path.endsWith('.js')
        ) {
          ctx.set('Content-Type', 'application/javascript; charset=utf-8');
        } else if (contentType.includes('text/html')) {
          ctx.set('Content-Type', 'text/html; charset=utf-8');
        } else if (contentType.includes('text/css')) {
          ctx.set('Content-Type', 'text/css; charset=utf-8');
        } else if (
          contentType.includes('application/javascript') ||
          contentType.includes('text/javascript')
        ) {
          ctx.set('Content-Type', 'application/javascript; charset=utf-8');
        }
      },

      onError: (err, ctx) => {
        ctx.status = 500;
        ctx.body = {
          status: 'error',
          message: 'Internal server error',
          details: err.message,
          path: ctx.request.path,
        };
      },
    })(ctx, next);
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      status: 'error',
      message: 'Internal server error',
      details: error.message,
      path: ctx.request.path,
    };
  }
};

module.exports.register = (router) => {
  router.get('/', cors(), handler);
};