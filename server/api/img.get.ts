import { defineEventHandler, getQuery, createError } from "h3";
import { ofetch } from "ofetch";

const ALLOWED_HOSTS = /^img[1-9]\.doubanio\.com$/;

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const raw = (query.url as string) || "";
  const url = decodeURIComponent(raw);

  if (!url || !url.startsWith("https://")) {
    throw createError({ statusCode: 400, statusMessage: "Invalid url" });
  }

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Invalid url" });
  }

  if (!ALLOWED_HOSTS.test(host)) {
    throw createError({ statusCode: 403, statusMessage: "Host not allowed" });
  }

  const resp = await ofetch<ArrayBuffer>(url, {
    responseType: "arrayBuffer",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://movie.douban.com/",
      Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
    },
    timeout: 8000,
  });

  const buffer = Buffer.from(resp);
  setHeader(event, "Cache-Control", "public, max-age=86400");
  const ext = url.split(".").pop()?.toLowerCase() || "jpg";
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  setHeader(event, "Content-Type", mime);
  return buffer;
});
