using System;
using System.Collections.Generic;
using System.IO;

// Cached in the MSI Binary table, so uninstall/recovery does not depend on
// potentially corrupt installed Node, scripts, configuration or environment.
internal static class ScratchCleanup {
    private static void Regular(string target) {
        if ((File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Reparse boundary requires operator inspection");
    }
    private static void Inspect(string root, List<string> files, List<string> directories) {
        Regular(root);
        foreach (string target in Directory.GetFileSystemEntries(root)) {
            Regular(target);
            if (Directory.Exists(target)) Inspect(target, files, directories);
            else files.Add(target);
        }
        directories.Add(root);
    }
    private static int Main() {
        try {
            string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "DevelopmentIntelligenceTrial", "scratch");
            if (!Directory.Exists(root)) return 0;
            for (string current = root; current != null; current = Path.GetDirectoryName(current)) Regular(current);
            var files = new List<string>();
            var directories = new List<string>();
            Inspect(root, files, directories);
            foreach (string file in files) { Regular(file); File.Delete(file); }
            foreach (string directory in directories) {
                Regular(directory);
                if (!String.Equals(directory, root, StringComparison.OrdinalIgnoreCase)) Directory.Delete(directory, false);
            }
            return 0;
        } catch { return 1; }
    }
}
