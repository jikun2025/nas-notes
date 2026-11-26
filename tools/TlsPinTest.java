import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * 复刻 MainActivity.applyNasTls 的 TLS 逻辑，验证：
 *  1) 固定 CA（static/ca.crt）能验证 caddy(28443) 的证书链；
 *  2) 默认(系统)信任会拒绝该链（证明 pin 是唯一通路，没被系统 CA 蒙混）；
 *  3) 宽松 hostname verifier 下 HTTPS GET /api/health 返回 200。
 * 运行：javac TlsPinTest.java && java -cp tools TlsPinTest https://192.168.5.10:28443 tools/../static/ca.crt
 */
public class TlsPinTest {
    static SSLContext pinned;
    static HostnameVerifier loose;

    static void buildPin(String caPath) throws Exception {
        try (InputStream in = new java.io.FileInputStream(caPath)) {
            CertificateFactory cf = CertificateFactory.getInstance("X509");
            Certificate ca = cf.generateCertificate(in);
            KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
            ks.load(null, null);
            ks.setCertificateEntry("nn-nas-ca", ca);
            TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(ks);
            TrustManager[] base = tmf.getTrustManagers();
            for (int i = 0; i < base.length; i++) {
                if (base[i] instanceof X509TrustManager) {
                    final X509TrustManager def = (X509TrustManager) base[i];
                    base[i] = new X509TrustManager() {
                        public void checkClientTrusted(X509Certificate[] c, String a) throws java.security.cert.CertificateException { def.checkClientTrusted(c, a); }
                        public void checkServerTrusted(X509Certificate[] c, String a) throws java.security.cert.CertificateException { def.checkServerTrusted(c, a); }
                        public X509Certificate[] getAcceptedIssuers() { return def.getAcceptedIssuers(); }
                    };
                }
            }
            pinned = SSLContext.getInstance("TLS");
            pinned.init(null, base, new java.security.SecureRandom());
        }
        loose = new HostnameVerifier() {
            public boolean verify(String hostname, SSLSession session) {
                try {
                    Certificate[] chain = session.getPeerCertificates();
                    if (chain.length == 0) return false;
                    if (!(chain[0] instanceof X509Certificate)) return false;
                    ((X509Certificate) chain[0]).checkValidity();
                    return hostname != null && !hostname.isEmpty();
                } catch (Exception e) { return false; }
            }
        };
    }

    static int get(String url, boolean pin) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        if (c instanceof HttpsURLConnection) {
            HttpsURLConnection h = (HttpsURLConnection) c;
            if (pin) { h.setSSLSocketFactory(pinned.getSocketFactory()); h.setHostnameVerifier(loose); }
        }
        c.setConnectTimeout(8000); c.setReadTimeout(8000);
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        byte[] buf = in == null ? new byte[0] : in.readAllBytes();
        System.out.println((pin ? "[pinned] " : "[default] ") + code + " " + new String(buf).trim());
        return code;
    }

    public static void main(String[] args) throws Exception {
        String server = args.length > 0 ? args[0] : "https://192.168.5.10:28443";
        String ca = args.length > 1 ? args[1] : "static/ca.crt";
        buildPin(ca);
        int ok = get(server + "/api/health", true);
        boolean pinnedReject = false;
        try { get(server + "/api/health", false); } catch (javax.net.ssl.SSLException e) {
            pinnedReject = true;
            System.out.println("[default] rejected as expected: " + e.getMessage());
        }
        if (ok == 200 && pinnedReject) System.out.println("RESULT: PASS (pin works, system trust rejects — chain is genuinely pinned)");
        else System.out.println("RESULT: FAIL (ok=" + ok + ", defaultRejected=" + pinnedReject + ")");
    }
}
