package manifest

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

// Content rule codes, shared with the registry's renderer (api/src/content.ts).
const (
	CodePageTooLarge  = "content_page_too_large"
	CodeRawHTML       = "content_raw_html"
	CodeImageType     = "content_image_type"
	CodeImageTooLarge = "content_image_too_large"
)

// MaxPageSize is the largest guide or docs page the registry renders; MaxImageSize the largest image it copies.
const (
	MaxPageSize  = 200 * 1024
	MaxImageSize = 2 << 20
)

var (
	fencedCode = regexp.MustCompile("(?ms)^ {0,3}(```|~~~).*?^ {0,3}(```|~~~)[^\\n]*$")
	inlineCode = regexp.MustCompile("`[^`\\n]+`")
	// Raw HTML is never rendered; these mean a page tries to embed active content.
	dangerousHTML = regexp.MustCompile(`(?i)<\s*/?\s*(script|iframe|object|embed|style|form|input|button|frame|frameset|meta|link|base|svg|math)\b|\son[a-z]+\s*=|javascript:`)
	mdImage       = regexp.MustCompile(`!\[[^\]]*\]\(\s*<?([^)\s>]+)`)
	imageTypes    = []string{".png", ".jpg", ".jpeg", ".webp", ".svg"}
)

// checkContent applies the registry's content rules to one Markdown page: its size, raw HTML, and
// images that are not PNG, JPEG, WebP or SVG files in the repository. rel is the page's path from the
// repository root, with forward slashes.
func checkContent(dir, rel string) []*Problem {
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
	if err != nil {
		return nil
	}
	var ps []*Problem
	if len(b) > MaxPageSize {
		ps = append(ps, &Problem{Code: CodePageTooLarge, Path: rel,
			Message: fmt.Sprintf("%s is %d KB; pages can be at most 200 KB", rel, (len(b)+1023)/1024), Hint: "split it into several pages"})
	}
	// Code is shown as code, so HTML inside it is fine.
	text := inlineCode.ReplaceAllString(fencedCode.ReplaceAllString(string(b), ""), "")
	if m := dangerousHTML.FindString(text); m != "" {
		ps = append(ps, &Problem{Code: CodeRawHTML, Path: rel, Message: "raw HTML is not allowed: " + strings.TrimSpace(m),
			Hint: "use Markdown; scripts, iframes, forms and styles are never rendered"})
	}
	for _, m := range mdImage.FindAllStringSubmatch(text, -1) {
		src := m[1]
		if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
			continue // shown as a link, never loaded
		}
		target := path.Clean(path.Join(path.Dir(rel), strings.SplitN(src, "?", 2)[0]))
		ok := !strings.Contains(src, ":") && !strings.HasPrefix(target, "../")
		ext := strings.ToLower(path.Ext(target))
		if !ok || !contains(imageTypes, ext) {
			ps = append(ps, &Problem{Code: CodeImageType, Path: rel,
				Message: fmt.Sprintf("image %s is not a PNG, JPEG, WebP or SVG file in the repository", src),
				Hint:    "keep images in the repository as .png, .jpg, .webp or .svg"})
			continue
		}
		fi, err := os.Stat(filepath.Join(dir, filepath.FromSlash(target)))
		switch {
		case err != nil:
			ps = append(ps, &Problem{Code: CodeFileMissing, Path: target, Message: "image " + target + " does not exist"})
		case fi.Size() > MaxImageSize:
			ps = append(ps, &Problem{Code: CodeImageTooLarge, Path: target,
				Message: fmt.Sprintf("%s is %.1f MB; images can be at most 2 MB", target, float64(fi.Size())/(1<<20)), Hint: "resize or compress it"})
		}
	}
	return ps
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
