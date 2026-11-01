export interface ImageSourceInput {
  attributes: Record<string, string>;
  baseUrl: string;
  currentSrc?: string;
  sourceSets?: string[];
  fallbackSrc?: string | null;
}

export interface ImageSourceSnapshot {
  attributes: string[];
  source: string | null;
}

// Keep these functions self-contained: selectors and CDP inject them into the page.
export function resolveImageSource(input: ImageSourceInput): string | null {
  function absoluteUrl(value: string | undefined | null): string | null {
    const trimmed = value?.trim();
    if (!trimmed || trimmed.startsWith("#") || /^(?:true|false)$/i.test(trimmed)) {
      return null;
    }
    try {
      const url = new URL(trimmed, input.baseUrl);
      return /^(?:https?:|blob:)$/.test(url.protocol) ||
        (url.protocol === "data:" && /^data:image\//i.test(trimmed))
        ? url.href
        : null;
    } catch {
      return null;
    }
  }

  function isPlaceholder(url: string): boolean {
    if (/^data:image\/svg\+xml[;,]/i.test(url)) {
      return true;
    }
    if (/^data:image\/gif;base64,R0lGOD(?:lh|dh)AQABA/i.test(url)) {
      return true;
    }
    const filename = new URL(url).pathname.split("/").pop() ?? "";
    return /^(?:placeholder|spacer|transparent|blank)(?:[._-]|$)/i.test(filename);
  }

  function realUrl(value: string | undefined | null): string | null {
    const url = absoluteUrl(value);
    return url && !isPlaceholder(url) ? url : null;
  }

  function fromSrcset(srcset: string): string | null {
    let position = 0;
    let bestUrl: string | null = null;
    let bestWidth = 0;
    let bestDensity = 0;
    while (position < srcset.length) {
      while (position < srcset.length && /[\t\n\f\r ,]/.test(srcset[position]!)) {
        position += 1;
      }
      const start = position;
      while (position < srcset.length && !/[\t\n\f\r ]/.test(srcset[position]!)) {
        position += 1;
      }
      let url = srcset.slice(start, position);
      let descriptors: string[] = [];
      if (url.endsWith(",")) {
        url = url.replace(/,+$/, "");
      } else {
        const descriptorStart = position;
        while (position < srcset.length && srcset[position] !== ",") {
          position += 1;
        }
        descriptors = srcset.slice(descriptorStart, position).trim().split(/\s+/).filter(Boolean);
      }
      const candidate = realUrl(url);
      if (!candidate || descriptors.length > 1) {
        continue;
      }
      const descriptor = descriptors[0] ?? "1x";
      const width = /^\d+w$/.test(descriptor) ? Number(descriptor.slice(0, -1)) : 0;
      const density = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?x$/.test(descriptor)
        ? Number(descriptor.slice(0, -1))
        : 0;
      if (Number.isFinite(width) && width > bestWidth) {
        bestUrl = candidate;
        bestWidth = width;
      } else if (bestWidth === 0 && Number.isFinite(density) && density > bestDensity) {
        bestUrl = candidate;
        bestDensity = density;
      }
    }
    return bestUrl;
  }

  const current = realUrl(input.currentSrc);
  if (current) {
    return current;
  }
  for (const srcset of [...(input.sourceSets ?? []), input.attributes.srcset ?? ""]) {
    const source = fromSrcset(srcset);
    if (source) {
      return source;
    }
  }
  const original = realUrl(input.attributes.src);
  if (original) {
    return original;
  }
  for (const name of ["data-srcset", "data-lazy-srcset", "data-original-srcset"]) {
    const source = fromSrcset(input.attributes[name] ?? "");
    if (source) {
      return source;
    }
  }
  for (const name of ["data-src", "data-original", "data-lazy-src", "data-original-src", "data-actualsrc"]) {
    const source = realUrl(input.attributes[name]);
    if (source) {
      return source;
    }
  }
  // Null leaves the original image and responsive attributes untouched.
  return realUrl(input.fallbackSrc);
}

export function collectImageSourcesInPage(root: ParentNode): ImageSourceSnapshot[] {
  function attributes(image: Element): Record<string, string> {
    return Object.fromEntries([...image.attributes].map((attribute) => [attribute.name, attribute.value]));
  }

  const images = [...root.querySelectorAll<HTMLImageElement>("img")];
  if ((root as Element).localName === "img") {
    images.unshift(root as HTMLImageElement);
  }
  return images.map((image) => {
    const picture = image.parentElement?.localName === "picture" ? image.parentElement : null;
    const sourceSets: string[] = [];
    // These formats are supported by the extension's minimum Chrome version.
    // Unknown types are left to currentSrc rather than guessed from their URLs.
    const supportedTypes = new Set([
      "image/avif", "image/webp", "image/png", "image/apng", "image/jpeg",
      "image/gif", "image/svg+xml", "image/bmp", "image/x-icon",
      "image/vnd.microsoft.icon"
    ]);
    for (const source of picture?.children ?? []) {
      if (source === image) {
        break;
      }
      if (source.localName !== "source") {
        continue;
      }
      const type = source.getAttribute("type")?.split(";")[0]?.trim().toLowerCase();
      const media = source.getAttribute("media");
      if ((type && !supportedTypes.has(type)) ||
        (media && !image.ownerDocument.defaultView?.matchMedia(media).matches)) {
        continue;
      }
      sourceSets.push(source.getAttribute("srcset") || source.getAttribute("data-srcset") || "");
    }
    const imageAttributes = attributes(image);
    let resolved = resolveImageSource({
      attributes: imageAttributes,
      baseUrl: image.baseURI,
      currentSrc: image.currentSrc,
      sourceSets
    });
    const sibling = (picture ?? image).nextElementSibling;
    if (!resolved && sibling?.localName === "noscript") {
      try {
        let fallbacks = sibling.querySelectorAll("img");
        if (fallbacks.length === 0) {
          // Template contents are inert and do not request fallback images.
          const template = image.ownerDocument.createElement("template");
          template.innerHTML = sibling.innerHTML;
          fallbacks = template.content.querySelectorAll("img");
        }
        if (fallbacks.length === 1) {
          resolved = resolveImageSource({
            attributes: attributes(fallbacks[0]!),
            baseUrl: image.baseURI
          });
        }
      } catch {
        // Trusted Types can forbid parsing. Skip only this optional fallback.
      }
    }
    return {
      attributes: [...image.attributes].flatMap((attribute) => [attribute.name, attribute.value]),
      source: resolved
    };
  });
}
