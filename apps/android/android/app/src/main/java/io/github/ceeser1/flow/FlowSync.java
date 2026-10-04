package io.github.ceeser1.flow;

import android.content.Context;
import android.net.ConnectivityManager;
import android.os.Build;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.StandardCopyOption;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * What the page asks of the phone and needs back at once: the shared client
 * (@flow/core/client) reads its files, its secrets and the device's name
 * synchronously, as Node lets it on the desktop. A Capacitor plugin call is
 * always asynchronous; a JavascriptInterface method is not (the page waits for
 * it), so these live here, as window.FlowSync. The rest is FlowNative.
 *
 * Every path must lie in the app's own storage (files or cache). Methods that
 * change something answer "" when done, else what went wrong; reads answer
 * null for a file that is not there.
 */
public class FlowSync {
    private static final String KEY_ALIAS = "flow-secrets";

    private final Context context;
    private final File filesDir;
    private final File cacheDir;
    private final SecureRandom random = new SecureRandom();

    FlowSync(Context context) {
        this.context = context.getApplicationContext();
        this.filesDir = canonical(this.context.getFilesDir());
        this.cacheDir = canonical(this.context.getCacheDir());
    }

    private static File canonical(File f) {
        try {
            return f.getCanonicalFile();
        } catch (IOException e) {
            return f.getAbsoluteFile();
        }
    }

    private static boolean inside(File f, File dir) {
        String p = f.getPath();
        String d = dir.getPath();
        return p.equals(d) || p.startsWith(d + File.separator);
    }

    /** `path` as a file of the app's own, or an exception. */
    private File file(String path) throws IOException {
        if (path == null || path.isEmpty()) throw new IOException("No file given.");
        File f = new File(path).getCanonicalFile();
        if (!inside(f, filesDir) && !inside(f, cacheDir)) throw new IOException("Not one of Flow's files: " + path);
        return f;
    }

    private static String error(Exception e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    /** Writes through a temporary file renamed over the old one, so a file is never half written. */
    private void writeAtomic(File dest, byte[] data) throws IOException {
        File dir = dest.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot make " + dir);
        File tmp = new File(dir, "." + dest.getName() + "." + Long.toHexString(random.nextLong()) + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
            out.getFD().sync();
        }
        try {
            Files.move(tmp.toPath(), dest.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            tmp.delete();
            throw e;
        }
    }

    // ---- the app ----

    /** { files, cache, device, sdk }: where the app keeps things, and what the phone is called. */
    @JavascriptInterface
    public String info() {
        try {
            JSONObject o = new JSONObject();
            o.put("files", filesDir.getPath());
            o.put("cache", cacheDir.getPath());
            o.put("device", deviceName());
            o.put("sdk", Build.VERSION.SDK_INT);
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /** The name the phone's owner gave it ("Galaxy A56"), else its maker and model. */
    @JavascriptInterface
    public String deviceName() {
        String name = null;
        try {
            name = Settings.Global.getString(context.getContentResolver(), Settings.Global.DEVICE_NAME);
        } catch (Exception e) {
            // Not readable here.
        }
        if (name == null || name.trim().isEmpty()) {
            String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
            String model = Build.MODEL == null ? "Android" : Build.MODEL;
            name = model.toLowerCase().startsWith(maker.toLowerCase()) ? model : (maker + " " + model).trim();
        }
        return name.trim();
    }

    /** Whether the network in use costs per byte (mobile data, a metered Wi-Fi). */
    @JavascriptInterface
    public boolean isMetered() {
        try {
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            return cm != null && cm.isActiveNetworkMetered();
        } catch (Exception e) {
            return false;
        }
    }

    // ---- files ----

    @JavascriptInterface
    public String readText(String path) {
        try {
            return new String(Files.readAllBytes(file(path).toPath()), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    @JavascriptInterface
    public String writeText(String path, String text) {
        try {
            writeAtomic(file(path), (text == null ? "" : text).getBytes(StandardCharsets.UTF_8));
            return "";
        } catch (Exception e) {
            return error(e);
        }
    }

    @JavascriptInterface
    public String readBase64(String path) {
        try {
            return Base64.encodeToString(Files.readAllBytes(file(path).toPath()), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    @JavascriptInterface
    public String writeBase64(String path, String data) {
        try {
            writeAtomic(file(path), Base64.decode(data == null ? "" : data, Base64.DEFAULT));
            return "";
        } catch (Exception e) {
            return error(e);
        }
    }

    @JavascriptInterface
    public boolean exists(String path) {
        try {
            return file(path).exists();
        } catch (Exception e) {
            return false;
        }
    }

    /** A file's size in bytes, -1 when it is not there. */
    @JavascriptInterface
    public double size(String path) {
        try {
            File f = file(path);
            return f.isFile() ? f.length() : -1;
        } catch (Exception e) {
            return -1;
        }
    }

    @JavascriptInterface
    public String mkdir(String path) {
        try {
            File f = file(path);
            if (!f.isDirectory() && !f.mkdirs()) return "Cannot make " + path;
            return "";
        } catch (Exception e) {
            return error(e);
        }
    }

    /** Removes a file, or a folder with `recursive`. Not being there is fine. */
    @JavascriptInterface
    public String remove(String path, boolean recursive) {
        try {
            File f = file(path);
            if (!f.exists()) return "";
            if (f.isDirectory()) {
                if (!recursive) return "That is a folder: " + path;
                deleteTree(f);
                return "";
            }
            return f.delete() ? "" : "Cannot delete " + path;
        } catch (Exception e) {
            return error(e);
        }
    }

    private static void deleteTree(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        f.delete();
    }

    @JavascriptInterface
    public String rename(String from, String to) {
        try {
            File dest = file(to);
            File dir = dest.getParentFile();
            if (dir != null && !dir.isDirectory()) dir.mkdirs();
            Files.move(file(from).toPath(), dest.toPath(), StandardCopyOption.REPLACE_EXISTING);
            return "";
        } catch (NoSuchFileException e) {
            return "Not there: " + from;
        } catch (Exception e) {
            return error(e);
        }
    }

    @JavascriptInterface
    public String copy(String from, String to) {
        try {
            File src = file(from);
            File dest = file(to);
            writeAtomic(dest, Files.readAllBytes(src.toPath()));
            return "";
        } catch (Exception e) {
            return error(e);
        }
    }

    /** A folder's entries: [{ name, size, dir }], [] when it is not there. */
    @JavascriptInterface
    public String list(String path) {
        JSONArray out = new JSONArray();
        try {
            File[] children = file(path).listFiles();
            if (children != null) {
                for (File c : children) {
                    JSONObject o = new JSONObject();
                    o.put("name", c.getName());
                    o.put("size", c.isFile() ? c.length() : 0);
                    o.put("dir", c.isDirectory());
                    out.put(o);
                }
            }
        } catch (Exception e) {
            // Nothing to list.
        }
        return out.toString();
    }

    /** A file's SHA-1 as hex, "" when it cannot be read (covers: their version). */
    @JavascriptInterface
    public String sha1(String path) {
        try (InputStream in = new FileInputStream(file(path))) {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest()) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception e) {
            return "";
        }
    }

    // ---- secrets (the server's password, a profile's PIN) ----
    //
    // Encrypted with a key kept in the Android Keystore, which never leaves the
    // phone: "k:<iv>:<data>", base64. What cannot be decrypted (another phone's,
    // a key that is gone) counts as no secret.

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return gen.generateKey();
    }

    @JavascriptInterface
    public String encrypt(String text) {
        if (text == null || text.isEmpty()) return "";
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] data = c.doFinal(text.getBytes(StandardCharsets.UTF_8));
            return "k:" + Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(data, Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public String decrypt(String stored) {
        if (stored == null || !stored.startsWith("k:")) return "";
        try {
            String[] parts = stored.split(":");
            if (parts.length != 3) return "";
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[1], Base64.DEFAULT)));
            return new String(c.doFinal(Base64.decode(parts[2], Base64.DEFAULT)), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }
}
