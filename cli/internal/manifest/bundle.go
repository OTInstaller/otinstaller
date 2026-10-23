package manifest

import (
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// The registry's upload limits (api/src/direct.ts). MaxBundleSize leaves room for the multipart framing.
const (
	MaxBundleSize  = 24 << 20
	MaxBundleFiles = 300
)

// BundleFile is one file `ot publish` uploads: its path relative to the manifest (forward slashes) and where it is.
type BundleFile struct {
	Path string
	File string
	Size int64
}

// Folders that never hold a package's pages or images.
var skipDirs = map[string]bool{"node_modules": true, "vendor": true, "dist": true, "build": true, "__pycache__": true}

// htmlImage finds <img src> in READMEs, which the registry renders with their HTML.
var htmlImage = regexp.MustCompile(`(?i)<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']`)

// BundleFiles lists what `ot publish` uploads for the manifest at manifestPath, whose package is in dir: the manifest
// (always as otinstaller.yaml), the files it names (the README, docs or guide pages) and the images they may show.
// The registry works out which images a page shows when it renders it, so every image under dir goes along (up to
// 2 MB each; dot folders and build output are skipped). When that is over the upload limit, only the images the
// pages reference are kept.
func BundleFiles(m *Manifest, manifestPath, dir string) ([]BundleFile, error) {
	files := map[string]BundleFile{}
	add := func(rel, file string) error {
		fi, err := os.Stat(file)
		if err != nil {
			return fmt.Errorf("%s does not exist", rel)
		}
		files[rel] = BundleFile{Path: rel, File: file, Size: fi.Size()}
		return nil
	}
	if err := add(FileName, manifestPath); err != nil {
		return nil, err
	}
	var pages []string
	if m.Readme != "" {
		pages = append(pages, m.Readme)
	}
	for _, p := range []*Pages{m.Docs, m.Content} {
		if p != nil {
			for _, page := range p.Nav {
				pages = append(pages, p.Root+page)
			}
		}
	}
	for _, rel := range pages {
		if err := add(rel, filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
			return nil, err
		}
	}

	images, err := allImages(dir)
	if err != nil {
		return nil, err
	}
	with := func(imgs []BundleFile) ([]BundleFile, int64) {
		out := map[string]BundleFile{}
		for k, v := range files {
			out[k] = v
		}
		for _, f := range imgs {
			if _, named := out[f.Path]; !named {
				out[f.Path] = f
			}
		}
		list := make([]BundleFile, 0, len(out))
		var total int64
		for _, f := range out {
			list = append(list, f)
			total += f.Size
		}
		sort.Slice(list, func(i, j int) bool { return list[i].Path < list[j].Path })
		return list, total
	}
	fits := func(list []BundleFile, total int64) bool {
		return total <= MaxBundleSize && len(list) <= MaxBundleFiles
	}

	list, total := with(images)
	if fits(list, total) {
		return list, nil
	}
	list, total = with(referencedImages(dir, pages, images))
	if fits(list, total) {
		return list, nil
	}
	return nil, fmt.Errorf("the upload would be %.1f MB in %d files; the registry takes at most %d MB and %d files",
		float64(total)/(1<<20), len(list), MaxBundleSize>>20, MaxBundleFiles)
}

// allImages lists the PNG, JPEG, WebP and SVG files under dir that the registry would copy (2 MB at most).
func allImages(dir string) ([]BundleFile, error) {
	var out []BundleFile
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != dir && (strings.HasPrefix(d.Name(), ".") || skipDirs[d.Name()]) {
				return filepath.SkipDir
			}
			return nil
		}
		if !contains(imageTypes, strings.ToLower(filepath.Ext(p))) {
			return nil
		}
		fi, err := d.Info()
		if err != nil || fi.Size() > MaxImageSize {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return nil
		}
		out = append(out, BundleFile{Path: filepath.ToSlash(rel), File: p, Size: fi.Size()})
		return nil
	})
	return out, err
}

// referencedImages keeps the images a page shows with Markdown or <img>, resolved from the page's folder.
func referencedImages(dir string, pages []string, images []BundleFile) []BundleFile {
	wanted := map[string]bool{}
	for _, rel := range pages {
		b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil {
			continue
		}
		var srcs []string
		for _, m := range mdImage.FindAllStringSubmatch(string(b), -1) {
			srcs = append(srcs, m[1])
		}
		for _, m := range htmlImage.FindAllStringSubmatch(string(b), -1) {
			srcs = append(srcs, m[1])
		}
		for _, src := range srcs {
			src = strings.SplitN(strings.SplitN(src, "#", 2)[0], "?", 2)[0]
			if strings.Contains(src, ":") || strings.HasPrefix(src, "//") {
				continue
			}
			if strings.HasPrefix(src, "/") {
				wanted[path.Clean(strings.TrimPrefix(src, "/"))] = true
			} else {
				wanted[path.Clean(path.Join(path.Dir(rel), src))] = true
			}
		}
	}
	var out []BundleFile
	for _, f := range images {
		if wanted[f.Path] {
			out = append(out, f)
		}
	}
	return out
}
