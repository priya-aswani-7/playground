const http = require("http");
const https = require("https");
const URL = require("url").URL;
const axios = require("axios");
const { JSDOM } = require("jsdom");
const cheerio = require("cheerio");

// set up axios with increased maximum content size (100MB)
axios.defaults.maxContentLength = 100 * 1024 * 1024;
// configure axios to handle redirects itself
axios.defaults.maxRedirects = 5;

const validateUrl = (url) => {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch (error) {
    return false;
  }
};

// improve url resolution to prevent recursion
const resolveUrl = (baseUrl, relativeUrl) => {
  if (!relativeUrl) return baseUrl;

  // check if this is already a proxied url     extract the real url
  if (relativeUrl.includes("?url=")) {
    try {
      const urlParam = new URL(relativeUrl).searchParams.get("url");
      if (urlParam) return urlParam;
    } catch (e) {
      // if parsing fails, continue with normal resolution
      console.error("Error parsing URL:", error, { baseUrl, relativeUrl });
    }
  }

  if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://")) {
    return relativeUrl;
  }

  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch (error) {
    console.error("Error resolving URL:", error, { baseUrl, relativeUrl });
    return null;
  }
};

// rewrite html content to proxy all resources
const rewriteHtml = (html, originalUrl, proxyBase) => {
  const baseUrlObj = new URL(originalUrl);
  const baseUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}`;
  const $ = cheerio.load(html);
  !$("head base").length && $("head").prepend(`<base href="${baseUrl}">`);

  function rewriteAttribute(selector, attribute) {
    $(selector).each((_, element) => {
      const value = $(element).attr(attribute);
      if (value && !value.startsWith("data:") && !value.startsWith("#")) {
        const absoluteUrl = resolveUrl(originalUrl, value);
        if (absoluteUrl) {
          $(element).attr(attribute, `${proxyBase}?url=${encodeURIComponent(absoluteUrl)}`);
        }
      }
    });
  }

  rewriteAttribute("a", "href");
  rewriteAttribute("link", "href");
  rewriteAttribute("script", "src");
  rewriteAttribute("img", "src");
  rewriteAttribute("iframe", "src");
  rewriteAttribute("source", "src");
  rewriteAttribute("img", "srcset");
  rewriteAttribute("source", "srcset");
  rewriteAttribute("video", "poster");
  rewriteAttribute("form", "action");
  rewriteAttribute("[style]", "style");

  $("[srcset]").each((_, element) => {
    const srcset = $(element).attr("srcset");
    if (srcset) {
      const newSrcset = srcset
        .split(",")
        .map((part) => {
          const [url, descriptor] = part.trim().split(/\s+/);
          if (url && !url.startsWith("data:")) {
            const absoluteUrl = resolveUrl(originalUrl, url);
            if (absoluteUrl) {
              return `${proxyBase}?url=${encodeURIComponent(absoluteUrl)} ${descriptor || ""}`.trim();
            }
          }
          return part;
        })
        .join(", ");
      $(element).attr("srcset", newSrcset);
    }
  });

  $("[style]").each((_, element) => {
    const style = $(element).attr("style");
    if (style && style.includes("url(")) {
      const newStyle = style.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
        if (url.startsWith("data:")) return match;
        const absoluteUrl = resolveUrl(originalUrl, url);
        if (absoluteUrl) {
          return `url(${proxyBase}?url=${encodeURIComponent(absoluteUrl)})`;
        }
        return match;
      });
      $(element).attr("style", newStyle);
    }
  });

  // rewrite css again for @import rules and url() in style tags
  $("style").each((_, element) => {
    let cssText = $(element).html();
    if (cssText) {
      // Rewrite @import
      cssText = cssText.replace(/@import\s+(['"])([^'"]+)(['"])/g, (match, quote1, url, quote2) => {
        const absoluteUrl = resolveUrl(originalUrl, url);
        if (absoluteUrl) {
          return `@import ${quote1}${proxyBase}?url=${encodeURIComponent(absoluteUrl)}${quote2}`;
        }
        return match;
      });

      // Rewrite url()
      cssText = cssText.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
        if (url.startsWith("data:")) return match;
        const absoluteUrl = resolveUrl(originalUrl, url);
        if (absoluteUrl) {
          return `url(${proxyBase}?url=${encodeURIComponent(absoluteUrl)})`;
        }
        return match;
      });

      $(element).html(cssText);
    }
  });

  const eventAttributes = [];

  eventAttributes.forEach((attr) => {
    $(`[${attr}]`).each((_, element) => {
      $(element).removeAttr(attr);
    });
  });

  // inject proxy helper script for history api patching
  const proxyHelperScript = `
    <script>
      // Keep track of URLs we've already processed to prevent infinite loops
      const processedUrls = new Set();
      
      // Patch History API methods to work in our proxy context
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      
      // Safely handle history manipulation
      history.pushState = function(state, title, url) {
        try {
          // If the URL is absolute and not from our origin, we need to handle it
          if (url && typeof url === 'string') {
            // If it's a proxied URL already, leave it alone
            if (!url.startsWith('${proxyBase}?url=') && !url.startsWith('/')) {
              // Convert to a relative path on our proxy
              const newUrl = window.location.pathname + window.location.search;
              return originalPushState.call(this, state, title, newUrl);
            }
          }
        } catch (e) {
          console.error('Proxy history.pushState error:', e);
        }
        // Try the original call with the possibly modified URL, but catch errors
        try {
          return originalPushState.call(this, state, title, url);
        } catch (e) {
          console.warn('Failed to execute history.pushState, using fallback', e);
          // Fallback - just use the current URL
          return originalPushState.call(this, state, title, window.location.pathname + window.location.search);
        }
      };
      
      history.replaceState = function(state, title, url) {
        try {
          // If the URL is absolute and not from our origin, we need to handle it
          if (url && typeof url === 'string') {
            // If it's a proxied URL already, leave it alone
            if (!url.startsWith('${proxyBase}?url=') && !url.startsWith('/')) {
              // Convert to a relative path on our proxy
              const newUrl = window.location.pathname + window.location.search;
              return originalReplaceState.call(this, state, title, newUrl);
            }
          }
        } catch (e) {
          console.error('Proxy history.replaceState error:', e);
        }
        // Try the original call with the possibly modified URL, but catch errors
        try {
          return originalReplaceState.call(this, state, title, url);
        } catch (e) {
          console.warn('Failed to execute history.replaceState, using fallback', e);
          // Fallback - just use the current URL
          return originalReplaceState.call(this, state, title, window.location.pathname + window.location.search);
        }
      };
      
      // fetch to proxy all requests 
      const originalFetch = window.fetch;
      window.fetch = function(url, options) {
        try {
          if (url && typeof url === 'string' && !url.startsWith('data:') && !url.startsWith('#') && !url.startsWith('blob:')) {
            // skip urls that already have been proxied
            if (!url.startsWith('${proxyBase}?url=')) {
              const absoluteUrl = new URL(url, window.location.href).href;
              // check if we've already processed this url to prevent loops
              if (!processedUrls.has(absoluteUrl)) {
                processedUrls.add(absoluteUrl);
                return originalFetch('${proxyBase}?url=' + encodeURIComponent(absoluteUrl), options)
                  .then(response => {
                    // not attemptting additional processing for error responses
                    if (!response.ok) {
                      console.warn('received error response:', response.status, response.statusText, url);
                    }
                    return response;
                  });
              }
            } else {
              // This is already a proxied URL, extract the original URL to avoid double-proxying
              try {
                const originalUrl = new URL(url).searchParams.get('url');
                if (originalUrl && !processedUrls.has(originalUrl)) {
                  processedUrls.add(originalUrl);
                  // use the original url directly to avoid double-proxying
                  return originalFetch(url, options);
                }
              } catch (e) {
                console.error('Error extracting original URL:', e);
              }
            }
          }
        } catch (e) {
          console.error('Proxy fetch error:', e);
        }
        return originalFetch(url, options);
      };
      
      // XMLHttpRequest with soemthign
      const originalXhrOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        try {
          if (url && typeof url === 'string' && !url.startsWith('data:') && !url.startsWith('#') && !url.startsWith('blob:')) {
            if (!url.startsWith('${proxyBase}?url=')) {
              const absoluteUrl = new URL(url, window.location.href).href;
              // check if we've already processed this url to prevent loops
              if (!processedUrls.has(absoluteUrl)) {
                processedUrls.add(absoluteUrl);
                return originalXhrOpen.call(this, method, '${proxyBase}?url=' + encodeURIComponent(absoluteUrl), ...rest);
              }
            } else {
              // when the url is already proxied, make sure we don't apply tracking logic
              return originalXhrOpen.call(this, method, url, ...rest);
            }
          }
        } catch (e) {
          console.error('Proxy XHR error:', e);
        }
        return originalXhrOpen.call(this, method, url, ...rest);
      };
      
      // patch window.location methods that might break in proxy context
      const originalAssign = window.location.assign;
      const originalReplace = window.location.replace;
      
      window.location.assign = function(url) {
        try {
          if (url && typeof url === 'string' && !url.startsWith('${proxyBase}?url=')) {
            if (!url.startsWith('/') && !url.startsWith('#')) {
              const absoluteUrl = new URL(url, window.location.href).href;
              return originalAssign.call(this, '${proxyBase}?url=' + encodeURIComponent(absoluteUrl));
            }
          }
        } catch (e) {
          console.error('Proxy location.assign error:', e);
        }
        return originalAssign.call(this, url);
      };
      
      window.location.replace = function(url) {
        try {
          if (url && typeof url === 'string' && !url.startsWith('${proxyBase}?url=')) {
            if (!url.startsWith('/') && !url.startsWith('#')) {
              const absoluteUrl = new URL(url, window.location.href).href;
              return originalReplace.call(this, '${proxyBase}?url=' + encodeURIComponent(absoluteUrl));
            }
          }
        } catch (e) {
          console.error('Proxy location.replace error:', e);
        }
        return originalReplace.call(this, url);
      };
      
      document.addEventListener('DOMContentLoaded', function() {
        const metaTags = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
        metaTags.forEach(tag => tag.remove());
        
        const observer = new MutationObserver(function(mutations) {
          mutations.forEach(function(mutation) {
            if (mutation.type === 'childList') {
              mutation.addedNodes.forEach(function(node) {
                if (node.tagName === 'SCRIPT' && node.src && 
                    !node.src.startsWith('${proxyBase}?url=') && 
                    !node.src.startsWith('data:')) {
                  try {
                    const absoluteUrl = new URL(node.src, window.location.href).href;
                    if (!processedUrls.has(absoluteUrl)) {
                      processedUrls.add(absoluteUrl);
                      node.src = '${proxyBase}?url=' + encodeURIComponent(absoluteUrl);
                    }
                  } catch (e) {
                    console.error('Error proxying dynamically added script:', e);
                  }
                }
              });
            }
          });
        });
        
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true
        });
      });
    </script>
  `;

  $("head").append(proxyHelperScript);

  return $.html();
};

// Proxy CSS files and rewrite URL references
const processCssContent = (css, baseUrl, proxyBase) => {
  return css
    .replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
      if (url.startsWith("data:")) return match;

      const absoluteUrl = resolveUrl(baseUrl, url);
      if (absoluteUrl) {
        return `url(${proxyBase}?url=${encodeURIComponent(absoluteUrl)})`;
      }
      return match;
    })
    .replace(/@import\s+(['"])([^'"]+)(['"])/g, (match, quote1, url, quote2) => {
      const absoluteUrl = resolveUrl(baseUrl, url);
      if (absoluteUrl) {
        return `@import ${quote1}${proxyBase}?url=${encodeURIComponent(absoluteUrl)}${quote2}`;
      }
      return match;
    });
};

// Improve JavaScript processing to avoid syntax errors
const processJavaScriptContent = (jsText, targetUrl, proxyBase) => {
  // Avoid modifying JavaScript code that might break syntax
  // Instead, focus only on clear URL patterns that won't cause syntax errors
  return jsText.replace(/(['"])((https?:)?\/\/[^'"]+)(['"])/g, (match, quote1, url, protocol, quote2) => {
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("#")) {
      return match;
    }

    try {
      const absoluteUrl = resolveUrl(targetUrl, url);
      if (absoluteUrl) {
        return `${quote1}${proxyBase}?url=${encodeURIComponent(absoluteUrl)}${quote2}`;
      }
    } catch (e) {
      // If any error occurs, return the original match
    }
    return match;
  });
};

// Main proxy handler
const handler = async (ctx) => {
  if (ctx.method === "OPTIONS") {
    setProxyHeaders(ctx);
    ctx.status = 204;
    return;
  }
  const targetUrl = ctx.query.url;
  if (!targetUrl || !validateUrl(targetUrl)) {
    ctx.status = 400;
    ctx.body = { status: "error", message: "Invalid URL." };
    return;
  }
  try {
    setProxyHeaders(ctx);
    const proxyBase = `http://${ctx.request.header.host}`;
    const headers = {
      "User-Agent": ctx.get("User-Agent") || "Mozilla/5.0",
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Referer: new URL(targetUrl).origin,
    };
    ctx.get("Cookie") && (headers["Cookie"] = ctx.get("Cookie"));
    if (ctx.method === "POST" || ctx.method === "PUT") {
      ctx.get("Content-Type") && (headers["Content-Type"] = ctx.get("Content-Type"));
    }

    const response = await axios(targetUrl, {
      method: ctx.method,
      headers,
      responseType: "arraybuffer",
      timeout: 30000,
      validateStatus: (status) => true,
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
    });

    ctx.status = response.status;
    if (response.status >= 400) {
      ctx.body = response.data;
      ctx.set("Content-Type", response.headers["content-type"] || "text/plain");
      return;
    }

    // Copy all headers from the proxied response, except those that would cause CORS issues
    Object.entries(response.headers).forEach(([key, value]) => {
      // Skip security headers that would restrict content
      const skipHeaders = [
        "content-security-policy",
        "content-security-policy-report-only",
        "clear-site-data",
        "cross-origin-embedder-policy",
        "cross-origin-opener-policy",
        "cross-origin-resource-policy",
        "x-content-type-options",
        "x-frame-options",
        "strict-transport-security",
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "set-cookie",
        "content-encoding",
        "content-length",
      ];

      if (!skipHeaders.includes(key.toLowerCase())) {
        ctx.set(key, value);
      }
    });

    // Handle different content types
    const contentType = response.headers["content-type"] || "";
    const urlPath = new URL(targetUrl).pathname.toLowerCase();

    // Convert buffer to string if needed for processing
    let responseData = response.data;
    let responseBuffer = response.data;

    // Process HTML content
    if (contentType.includes("text/html")) {
      try {
        const contentEncoding = response.headers["content-encoding"];
        const textDecoder = new TextDecoder("utf-8");
        const htmlText = textDecoder.decode(responseBuffer);

        const rewrittenHtml = rewriteHtml(htmlText, targetUrl, proxyBase);
        ctx.body = rewrittenHtml;
        ctx.set("Content-Type", "text/html; charset=utf-8");
      } catch (error) {
        console.error("Error processing HTML:", error);
        ctx.body = responseBuffer; // Fallback to unmodified content
      }
    }

    // process css content
    else if (contentType.includes("text/css") || urlPath.endsWith(".css")) {
      try {
        const textDecoder = new TextDecoder("utf-8");
        const cssText = textDecoder.decode(responseBuffer);

        const rewrittenCss = processCssContent(cssText, targetUrl, proxyBase);
        ctx.body = rewrittenCss;
        ctx.set("Content-Type", "text/css; charset=utf-8");
      } catch (error) {
        console.error("Error processing CSS:", error);
        ctx.body = responseBuffer;
      }
    }

    // js content - check for both content type AND file extension
    else if (contentType.includes("javascript") || urlPath.endsWith(".js")) {
      try {
        const textDecoder = new TextDecoder("utf-8");
        const jsText = textDecoder.decode(responseBuffer);

        // using the improved js processing function
        const rewrittenJs = processJavaScriptContent(jsText, targetUrl, proxyBase);
        ctx.body = rewrittenJs;

        // set correct mime type for js files
        ctx.set("Content-Type", "application/javascript; charset=utf-8");
      } catch (error) {
        console.error("Error processing JavaScript:", error);
        ctx.body = responseBuffer;
        if (urlPath.endsWith(".js")) {
          ctx.set("Content-Type", "application/javascript; charset=utf-8");
        }
      }
    }

    // json content
    else if (contentType.includes("application/json") && !urlPath.endsWith(".js")) {
      try {
        const textDecoder = new TextDecoder("utf-8");
        const jsonText = textDecoder.decode(responseBuffer);

        // parse,  re-stringify to ensure valid json
        const jsonData = JSON.parse(jsonText);
        ctx.body = JSON.stringify(jsonData);
        ctx.set("Content-Type", "application/json; charset=utf-8");
      } catch (error) {
        console.error("Error processing JSON:", error);
        ctx.body = responseBuffer; // Fallback to unmodified content
      }
    }

    // other content types
    else {
      ctx.body = responseBuffer;

      // Correct MIME types for common file extensions if needed
      if (urlPath.endsWith(".js") && !contentType.includes("javascript")) {
        ctx.set("Content-Type", "application/javascript; charset=utf-8");
      }
    }

    console.log(`✅ Proxied: ${targetUrl} (${contentType})`);
  } catch (error) {
    console.error("❌ Error:", error.message);
    ctx.status = 500;
    ctx.body = { status: "error", message: "Failed", details: error.message };
  }
};

const setProxyHeaders = (ctx) => {
  ctx.set("Access-Control-Allow-Origin", "*");
  ctx.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  ctx.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Origin, Accept");
  ctx.set("Access-Control-Allow-Credentials", "true");
  ctx.set("Access-Control-Max-Age", "86400");

  // for firewall stuff
  ctx.set("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  ctx.set("X-Frame-Options", "ALLOWALL");
  ctx.set("X-Content-Type-Options", "nosniff");
  ctx.set("Referrer-Policy", "no-referrer");

  ctx.remove("Strict-Transport-Security");
  ctx.remove("Permissions-Policy");
};

module.exports.register = (router) => {
  router.get("/", handler);
  router.post("/", handler);
  router.put("/", handler);
  router.delete("/", handler);
  router.options("/", setProxyHeaders);
};
