package backend

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

func createDotCrushDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("failed to create data directory: %q %w", dir, err)
	}

	gitIgnorePath := filepath.Join(dir, ".gitignore")
	f, err := os.OpenFile(gitIgnorePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return nil
		}
		return fmt.Errorf("failed to create .gitignore file: %q %w", gitIgnorePath, err)
	}
	defer f.Close()
	if _, err := f.WriteString("*\n"); err != nil {
		return fmt.Errorf("failed to write .gitignore file: %q %w", gitIgnorePath, err)
	}

	return nil
}
