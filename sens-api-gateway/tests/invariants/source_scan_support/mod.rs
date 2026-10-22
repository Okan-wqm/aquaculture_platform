//! Source scanner shared by the ADR-048 filesystem and environment
//! invariants (`no_etc_write_paths.rs`, `no_security_env_in_suderra_os.rs`).
//!
//! It lexes Rust source just far enough to tell code from comments and
//! string literals, and drops every item gated by `#[cfg(test)]` or
//! `#[cfg(all(test, ...))]`, so the invariants judge only what a release
//! build compiles. A literal path in a doc comment or a unit test is not a
//! write path; a literal in production code is.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// A string literal of production code.
#[derive(Debug, Clone)]
pub struct Literal {
    /// 1-based line of the opening quote.
    pub line: usize,
    /// The literal's raw contents (escapes not processed).
    pub text: String,
}

/// A scanned source file.
pub struct Scanned {
    /// Crate-relative path, e.g. `src/paths.rs`.
    pub rel: String,
    /// The production code with comments, string contents and test-gated
    /// items blanked out (same byte offsets and line breaks as the file).
    pub code: String,
    /// The production string literals.
    pub literals: Vec<Literal>,
}

impl Scanned {
    /// 1-based line numbers of the production code where `needle` occurs.
    pub fn code_lines_with(&self, needle: &str) -> Vec<usize> {
        let mut lines = Vec::new();
        let mut from = 0;
        while let Some(pos) = self.code[from..].find(needle) {
            let at = from + pos;
            lines.push(line_of(&self.code, at));
            from = at + needle.len();
        }
        lines
    }
}

/// Every `fn <name>` of the code with its body (the text between the braces
/// that follow the signature). Several functions may share a name (the
/// handle's and the client's `write_coil`).
#[allow(dead_code)]
pub fn functions(code: &str) -> BTreeMap<String, Vec<String>> {
    let bytes = code.as_bytes();
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut from = 0;
    while let Some(pos) = code[from..].find("fn ") {
        let at = from + pos;
        from = at + 3;
        if at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_') {
            continue;
        }
        let name: String = code[at + 3..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if name.is_empty() {
            continue;
        }
        // The body opens at the first `{` after the signature; a trait
        // method declaration ends at `;` first.
        let rest = &code[at..];
        let (Some(open), semi) = (rest.find('{'), rest.find(';')) else {
            continue;
        };
        if semi.is_some_and(|s| s < open) {
            continue;
        }
        let mut depth = 0usize;
        let mut end = None;
        for (i, b) in rest.bytes().enumerate().skip(open) {
            match b {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(i);
                        break;
                    }
                }
                _ => {}
            }
        }
        let end = end.unwrap_or_else(|| panic!("unbalanced braces in fn {name}"));
        out.entry(name)
            .or_default()
            .push(rest[open..=end].to_string());
    }
    out
}

/// The crate root (`sens-api-gateway/`).
pub fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Every `.rs` file under `src/`, scanned.
pub fn scan_src() -> Vec<Scanned> {
    let root = crate_root();
    let mut files = Vec::new();
    collect_rs(&root.join("src"), &mut files);
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let text = std::fs::read_to_string(&path).expect("read source");
            let rel = path
                .strip_prefix(&root)
                .expect("under crate root")
                .to_string_lossy()
                .replace('\\', "/");
            scan(&rel, &text)
        })
        .collect()
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read_dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

fn line_of(text: &str, byte: usize) -> usize {
    text.as_bytes()[..byte]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1
}

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Scan one file.
pub fn scan(rel: &str, text: &str) -> Scanned {
    let bytes = text.as_bytes();
    let mut code = bytes.to_vec();
    let mut literals: Vec<(usize, usize, String)> = Vec::new(); // (start byte, line, text)
    let blank = |code: &mut Vec<u8>, from: usize, to: usize| {
        for b in &mut code[from..to] {
            if *b != b'\n' {
                *b = b' ';
            }
        }
    };
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let next = bytes.get(i + 1).copied();
        if b == b'/' && next == Some(b'/') {
            let end = text[i..].find('\n').map_or(bytes.len(), |p| i + p);
            blank(&mut code, i, end);
            i = end;
        } else if b == b'/' && next == Some(b'*') {
            let mut depth = 1;
            let mut j = i + 2;
            while j < bytes.len() && depth > 0 {
                if bytes[j] == b'/' && bytes.get(j + 1) == Some(&b'*') {
                    depth += 1;
                    j += 2;
                } else if bytes[j] == b'*' && bytes.get(j + 1) == Some(&b'/') {
                    depth -= 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            blank(&mut code, i, j);
            i = j;
        } else if (b == b'r' || (b == b'b' && next == Some(b'r')))
            && (i == 0 || !is_ident(bytes[i - 1]))
        {
            // Raw string r"..", r#".."#, br"..".
            let mut j = if b == b'b' { i + 2 } else { i + 1 };
            let mut hashes = 0;
            while bytes.get(j) == Some(&b'#') {
                hashes += 1;
                j += 1;
            }
            if bytes.get(j) == Some(&b'"') {
                let body_start = j + 1;
                let closing: Vec<u8> = std::iter::once(b'"')
                    .chain(std::iter::repeat_n(b'#', hashes))
                    .collect();
                let mut k = body_start;
                while k < bytes.len() && !bytes[k..].starts_with(&closing) {
                    k += 1;
                }
                literals.push((i, line_of(text, i), text[body_start..k].to_string()));
                blank(&mut code, body_start, k);
                i = (k + closing.len()).min(bytes.len());
            } else {
                i += 1;
            }
        } else if b == b'"' {
            let body_start = i + 1;
            let mut k = body_start;
            while k < bytes.len() && bytes[k] != b'"' {
                if bytes[k] == b'\\' {
                    k += 1;
                }
                k += 1;
            }
            let k = k.min(bytes.len());
            literals.push((i, line_of(text, i), text[body_start..k].to_string()));
            blank(&mut code, body_start, k);
            i = k + 1;
        } else if b == b'\'' {
            // Char literal ('x', '\n', '\''), else a lifetime.
            if next == Some(b'\\') {
                let mut k = i + 2;
                while k < bytes.len() && bytes[k] != b'\'' {
                    k += 1;
                }
                blank(&mut code, i + 1, k);
                i = k + 1;
            } else if bytes.get(i + 2) == Some(&b'\'') {
                blank(&mut code, i + 1, i + 2);
                i += 3;
            } else {
                // Multi-byte UTF-8 char literal or a lifetime.
                let rest = &text[i + 1..];
                let mut chars = rest.char_indices();
                match (chars.next(), chars.next()) {
                    (Some((_, _)), Some((off, '\''))) => {
                        blank(&mut code, i + 1, i + 1 + off);
                        i = i + 1 + off + 1;
                    }
                    _ => i += 1,
                }
            }
        } else {
            i += 1;
        }
    }

    let code = String::from_utf8(code).expect("blanking keeps UTF-8 boundaries");
    let test_regions = test_regions(&code);
    let in_test = |at: usize| test_regions.iter().any(|(s, e)| at >= *s && at < *e);
    let mut code_bytes = code.into_bytes();
    for (s, e) in &test_regions {
        for b in &mut code_bytes[*s..*e] {
            if *b != b'\n' {
                *b = b' ';
            }
        }
    }
    Scanned {
        rel: rel.to_string(),
        code: String::from_utf8(code_bytes).expect("UTF-8"),
        literals: literals
            .into_iter()
            .filter(|(at, _, _)| !in_test(*at))
            .map(|(_, line, text)| Literal { line, text })
            .collect(),
    }
}

/// Byte ranges of items gated by `#[cfg(test)]` / `#[cfg(all(test, ..))]`,
/// computed on comment- and string-blanked code.
fn test_regions(code: &str) -> Vec<(usize, usize)> {
    let bytes = code.as_bytes();
    let mut regions = Vec::new();
    for marker in ["#[cfg(test)]", "#[cfg(all(test"] {
        let mut from = 0;
        while let Some(pos) = code[from..].find(marker) {
            let start = from + pos;
            // The gated item ends at the brace matching its first `{`, or
            // at the first `;` when that comes before any `{`.
            let after = start + marker.len();
            // `#[cfg(test)]` is complete; `#[cfg(all(test` runs to its `]`.
            let attr_end = if marker.ends_with(']') {
                after
            } else {
                code[after..].find(']').map_or(after, |p| after + p + 1)
            };
            let brace = code[attr_end..].find('{').map(|p| attr_end + p);
            let semi = code[attr_end..].find(';').map(|p| attr_end + p);
            let end = match (brace, semi) {
                (Some(b), Some(s)) if s < b => s + 1,
                (Some(b), _) => {
                    let mut depth = 0usize;
                    let mut k = b;
                    while k < bytes.len() {
                        match bytes[k] {
                            b'{' => depth += 1,
                            b'}' => {
                                depth -= 1;
                                if depth == 0 {
                                    break;
                                }
                            }
                            _ => {}
                        }
                        k += 1;
                    }
                    (k + 1).min(bytes.len())
                }
                (None, Some(s)) => s + 1,
                (None, None) => bytes.len(),
            };
            regions.push((start, end));
            from = after;
        }
    }
    regions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_strings_and_test_items_are_told_apart() {
        let src = r##"
// "/etc/in-a-comment"
/// doc "/etc/in-a-doc"
const A: &str = "/etc/prod";
const B: &str = r#"/etc/raw"#;
fn f() { let _c = '"'; let _l: &'static str = "/var/x"; }
#[cfg(test)]
mod tests { const T: &str = "/etc/test-only"; fn g() { std::env::var("X"); } }
#[cfg(all(test, feature = "x"))]
fn h() { let _ = "/etc/also-test"; }
fn k() { std::env::var("Y"); }
#[cfg(test)]
fn helper() -> u8 { 1 }
fn prod() { let _a = [0u8; 2]; let _p = "/etc/after-helper"; }
"##;
        let s = scan("src/x.rs", src);
        let texts: Vec<_> = s.literals.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(
            texts,
            ["/etc/prod", "/etc/raw", "/var/x", "Y", "/etc/after-helper"]
        );
        assert_eq!(s.code_lines_with("env::var("), vec![11]);
    }
}
