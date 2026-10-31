//! Markdown → HTML. Local images and links are rewritten so the webview can use them:
//! images become asset-protocol URLs, links to local files become `mdv-open:` URLs
//! that the UI intercepts.

use std::path::{Component, Path, PathBuf};

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag};
use serde::Serialize;

#[derive(Serialize)]
pub struct Rendered {
    pub html: String,
}

pub fn render_file(path: &Path) -> std::io::Result<Rendered> {
    let bytes = std::fs::read(path)?;
    let text = String::from_utf8_lossy(&bytes);
    let base = path.parent().unwrap_or_else(|| Path::new("/"));
    Ok(render(&text, base))
}

pub fn render(src: &str, base: &Path) -> Rendered {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts.insert(Options::ENABLE_GFM);

    let parser = Parser::new_ext(strip_front_matter(src), opts).map(|ev| match ev {
        Event::Start(Tag::Image { link_type, dest_url, title, id }) => Event::Start(Tag::Image {
            link_type,
            dest_url: rewrite_image(dest_url, base),
            title,
            id,
        }),
        Event::Start(Tag::Link { link_type, dest_url, title, id }) => Event::Start(Tag::Link {
            link_type,
            dest_url: rewrite_link(dest_url, base),
            title,
            id,
        }),
        other => other,
    });

    let mut out = String::with_capacity(src.len() * 3 / 2);
    html::push_html(&mut out, parser);
    Rendered { html: out }
}

/// Drops a leading YAML front-matter block (`---` … `---`).
fn strip_front_matter(src: &str) -> &str {
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    let Some(rest) = src.strip_prefix("---\n").or_else(|| src.strip_prefix("---\r\n")) else {
        return src;
    };
    let mut offset = src.len() - rest.len();
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        let t = line.trim_end();
        if t == "---" || t == "..." {
            return &src[offset..];
        }
    }
    src
}

fn is_external(url: &str) -> bool {
    url.starts_with('#')
        || url.contains("://")
        || ["mailto:", "tel:", "data:"].iter().any(|s| url.starts_with(s))
}

fn resolve(base: &Path, url: &str) -> PathBuf {
    let decoded = percent_decode_str(url).decode_utf8_lossy();
    let joined = base.join(decoded.as_ref());
    // Lexically normalise `.` and `..` without touching the disk.
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn encode(p: &Path) -> String {
    utf8_percent_encode(&p.to_string_lossy(), NON_ALPHANUMERIC).to_string()
}

fn rewrite_image<'a>(url: CowStr<'a>, base: &Path) -> CowStr<'a> {
    if url.is_empty() || is_external(&url) {
        return url;
    }
    let path = resolve(base, url.split(['?', '#']).next().unwrap_or(""));
    let prefix = if cfg!(windows) { "http://asset.localhost/" } else { "asset://localhost/" };
    format!("{prefix}{}", encode(&path)).into()
}

fn rewrite_link<'a>(url: CowStr<'a>, base: &Path) -> CowStr<'a> {
    if url.is_empty() || is_external(&url) {
        return url;
    }
    let (path_part, fragment) = match url.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (url.as_ref(), None),
    };
    let path = resolve(base, path_part);
    let mut href = format!("mdv-open:{}", encode(&path));
    if let Some(f) = fragment {
        href.push('#');
        href.push_str(f);
    }
    href.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_gfm() {
        let r = render("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n~~old~~", Path::new("/d"));
        assert!(r.html.contains("<h1>Title</h1>"));
        assert!(r.html.contains("<table>"));
        assert!(r.html.contains("checkbox"));
        assert!(r.html.contains("<del>old</del>"));
    }

    #[test]
    fn strips_front_matter() {
        let r = render("---\ntitle: x\n---\n# Body", Path::new("/d"));
        assert!(!r.html.contains("title: x"));
        assert!(r.html.contains("<h1>Body</h1>"));
    }

    #[test]
    fn rewrites_local_image_and_link() {
        let r = render("![pic](img/a%20b.png) [next](../other.md#sec) [web](https://x.y) [top](#a)", Path::new("/docs/sub"));
        assert!(r.html.contains("asset://localhost/%2Fdocs%2Fsub%2Fimg%2Fa%20b%2Epng"), "{}", r.html);
        assert!(r.html.contains("href=\"mdv-open:%2Fdocs%2Fother%2Emd#sec\""), "{}", r.html);
        assert!(r.html.contains("href=\"https://x.y\""));
        assert!(r.html.contains("href=\"#a\""));
    }
}
