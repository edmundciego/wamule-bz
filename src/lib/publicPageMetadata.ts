type PublicPageMetadata = {
  title: string;
  description: string;
  url: string;
};

const META_CONTENT = [
  ['meta[name="description"]', "name", "description"],
  ['meta[property="og:type"]', "property", "og:type"],
  ['meta[property="og:title"]', "property", "og:title"],
  ['meta[property="og:description"]', "property", "og:description"],
  ['meta[property="og:url"]', "property", "og:url"],
  ['meta[name="twitter:card"]', "name", "twitter:card"],
  ['meta[name="twitter:title"]', "name", "twitter:title"],
  ['meta[name="twitter:description"]', "name", "twitter:description"],
] as const;

export function publicCanonicalUrl(href: string): string {
  const url = new URL(href);
  for (const key of ["feature", "lot", "filter", "view", "apply_feature", "apply"]) url.searchParams.delete(key);
  url.hash = "";
  return url.toString();
}

/** Update browser-visible metadata for a public SPA route and restore it on unmount. */
export function applyPublicPageMetadata(metadata: PublicPageMetadata): () => void {
  const previousTitle = document.title;
  const previousMeta: Array<{ element: HTMLMetaElement; content: string; created: boolean }> = [];
  const previousCanonical: { element: HTMLLinkElement; href: string; created: boolean } = (() => {
    let element = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const created = !element;
    if (!element) {
      element = document.createElement("link");
      element.rel = "canonical";
      document.head.append(element);
    }
    const snapshot = { element, href: element.href, created };
    element.href = metadata.url;
    return snapshot;
  })();

  const contentByKey: Record<string, string> = {
    description: metadata.description,
    "og:type": "website",
    "og:title": metadata.title,
    "og:description": metadata.description,
    "og:url": metadata.url,
    "twitter:card": "summary",
    "twitter:title": metadata.title,
    "twitter:description": metadata.description,
  };

  for (const [selector, attribute, key] of META_CONTENT) {
    let element = document.head.querySelector<HTMLMetaElement>(selector);
    const created = !element;
    if (!element) {
      element = document.createElement("meta");
      element.setAttribute(attribute, key);
      document.head.append(element);
    }
    previousMeta.push({ element, content: element.content, created });
    element.content = contentByKey[key];
  }
  document.title = metadata.title;

  return () => {
    document.title = previousTitle;
    for (const snapshot of previousMeta) {
      if (snapshot.created) snapshot.element.remove();
      else snapshot.element.content = snapshot.content;
    }
    if (previousCanonical.created) previousCanonical.element.remove();
    else previousCanonical.element.href = previousCanonical.href;
  };
}
