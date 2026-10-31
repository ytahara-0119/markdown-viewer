//! Builds the sidebar tree: Markdown files only, with noisy folders skipped.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MD_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd"];
const IGNORED_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "vendor", "__pycache__"];
const MAX_DEPTH: usize = 12;
const MAX_FILES: usize = 5000;

#[derive(Serialize)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub children: Vec<Node>,
}

pub fn is_markdown(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| MD_EXTS.iter().any(|m| m.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

fn is_ignored_name(name: &str) -> bool {
    name.starts_with('.') || IGNORED_DIRS.contains(&name)
}

/// True when `p` lives inside a hidden or ignored folder below `root`.
pub fn is_ignored_path(root: &Path, p: &Path) -> bool {
    match p.strip_prefix(root) {
        Ok(rel) => rel
            .components()
            .any(|c| is_ignored_name(&c.as_os_str().to_string_lossy())),
        Err(_) => true,
    }
}

pub fn build(root: &Path) -> io::Result<Node> {
    let mut count = 0;
    let children = walk(root, 0, &mut count)?;
    Ok(Node {
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
        path: root.to_string_lossy().into_owned(),
        dir: true,
        children,
    })
}

fn walk(dir: &Path, depth: usize, count: &mut usize) -> io::Result<Vec<Node>> {
    if depth > MAX_DEPTH {
        return Ok(Vec::new());
    }
    let mut entries: Vec<_> = fs::read_dir(dir)?.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries {
        if *count >= MAX_FILES {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored_name(&name) {
            continue;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };

        if ft.is_dir() {
            // Symlinked folders are skipped (ft.is_dir() is false for them) to avoid loops.
            if let Ok(children) = walk(&path, depth + 1, count) {
                if !children.is_empty() {
                    dirs.push(node(name, &path, true, children));
                }
            }
        } else if is_markdown(&path) && (ft.is_file() || path.is_file()) {
            *count += 1;
            files.push(node(name, &path, false, Vec::new()));
        }
    }
    dirs.extend(files);
    Ok(dirs)
}

fn node(name: String, path: &Path, dir: bool, children: Vec<Node>) -> Node {
    Node { name, path: path.to_string_lossy().into_owned(), dir, children }
}

/// A file to show automatically when a folder is opened.
pub fn find_index(dir: &Path) -> Option<PathBuf> {
    ["README.md", "Readme.md", "readme.md", "index.md"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_tree_with_only_markdown() {
        let tmp = std::env::temp_dir().join(format!("mdv-tree-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("docs/empty")).unwrap();
        fs::create_dir_all(tmp.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(tmp.join(".git")).unwrap();
        fs::write(tmp.join("README.md"), "# hi").unwrap();
        fs::write(tmp.join("main.rs"), "").unwrap();
        fs::write(tmp.join("docs/guide.markdown"), "").unwrap();
        fs::write(tmp.join("node_modules/pkg/README.md"), "").unwrap();
        fs::write(tmp.join(".git/notes.md"), "").unwrap();

        let tree = build(&tmp).unwrap();
        let names: Vec<_> = tree.children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["docs", "README.md"]);
        assert_eq!(tree.children[0].children.len(), 1);
        assert_eq!(find_index(&tmp), Some(tmp.join("README.md")));
        assert!(is_ignored_path(&tmp, &tmp.join(".git/x.md")));
        assert!(!is_ignored_path(&tmp, &tmp.join("docs/guide.markdown")));
        fs::remove_dir_all(&tmp).unwrap();
    }
}
