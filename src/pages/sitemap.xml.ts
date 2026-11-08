import type { APIRoute } from 'astro';
import { getFeaturedPairs } from '../lib/pairs.ts';

/**
 * AllFinConverter Sitemap Endpoint
 *
 * Generates a valid sitemap.xml containing exclusively real, generated routes:
 * 1. Homepage ('/')
 * 2. Static information pages ('/about/', '/how-it-works/', '/privacy/', '/terms/', '/contact/')
 * 3. Generated conversion pair pages (from getFeaturedPairs())
 *
 * Automatically stays synchronized with the pair engine and static pages to prevent 404s or stale entries.
 *
 * lastmod is intentionally omitted — genuine per-page modification dates cannot be
 * reliably maintained, and invented dates violate the Sitemaps protocol specification.
 */
export const STATIC_INFO_ROUTES = [
  {
    path: '/about/',
    changefreq: 'monthly',
    priority: '0.6',
  },
  {
    path: '/how-it-works/',
    changefreq: 'monthly',
    priority: '0.6',
  },
  {
    path: '/privacy/',
    changefreq: 'monthly',
    priority: '0.5',
  },
  {
    path: '/terms/',
    changefreq: 'monthly',
    priority: '0.5',
  },
  {
    path: '/contact/',
    changefreq: 'monthly',
    priority: '0.5',
  },
] as const;

export const GET: APIRoute = ({ site }) => {
  const baseUrl = site ? site.toString().replace(/\/$/, '') : 'https://allfinconverter.com';

  const featuredPairs = getFeaturedPairs();

  const routes = [
    {
      path: '/',
      changefreq: 'daily',
      priority: '1.0',
    },
    ...STATIC_INFO_ROUTES,
    ...featuredPairs.map((pair) => ({
      path: `/${pair.slug}`,
      changefreq: 'daily',
      priority: '0.8',
    })),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map((r) => {
    const loc = baseUrl ? `${baseUrl}${r.path}` : r.path;
    return `  <url>
    <loc>${loc}</loc>
    <changefreq>${r.changefreq}</changefreq>
    <priority>${r.priority}</priority>
  </url>`;
  })
  .join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  });
};
