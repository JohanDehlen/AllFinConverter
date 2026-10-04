import type { APIRoute } from 'astro';

/**
 * WorthPair Sitemap Endpoint
 *
 * Generates a valid sitemap.xml for existing routes.
 * Prepared for future conversion pair routes without populating non-existent pages.
 */
export const GET: APIRoute = ({ site }) => {
  const baseUrl = site ? site.toString().replace(/\/$/, '') : '';

  // Only existing, real pages are included
  const routes = [
    {
      path: '/',
      lastmod: '2026-01-01',
      changefreq: 'daily',
      priority: '1.0',
    },
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map((r) => {
    const loc = baseUrl ? `${baseUrl}${r.path}` : r.path;
    return `  <url>
    <loc>${loc}</loc>
    <lastmod>${r.lastmod}</lastmod>
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
