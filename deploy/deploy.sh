# 一键部署轻签 NasNotes 到飞牛 NAS（在 NAS 的 SSH/网页终端里执行）
# 用法：把整个仓库目录传到 NAS（例如 ~/nas-notes），cd 进去后执行 bash deploy/deploy.sh
set -euo pipefail

TARGET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$TARGET_DIR"
echo "部署目录: $TARGET_DIR"

if [ ! -f .env ]; then
  echo "缺少 .env。请先生成随机令牌（任选一种）：" >&2
  echo "  openssl rand -hex 24" >&2
  echo "  python3 -c \"import secrets;print(secrets.token_hex(24))\"" >&2
  echo "然后把结果写入 .env（一行：NOTES_TOKEN=随机串），再重新运行本脚本。" >&2
  exit 1
fi

# 飞牛自带 Docker；若无 compose v2 插件则退回 docker-compose
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "未找到 docker compose，请先在飞牛「Docker」应用里启用 Compose" >&2
  exit 1
fi

$DC build
$DC up -d
sleep 2
echo "== 健康检查 =="
curl -sf http://127.0.0.1:28080/api/health && echo || echo "健康检查未通过，查看日志: $DC logs --tail 50"

echo "== 完成 =="
echo "局域网访问: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 192.168.5.10):28080"
echo "访问令牌（填入网页/APP 设置）: 见 .env 里的 NOTES_TOKEN，cat .env 查看"
echo "提醒：手机浏览器 PWA 与麦克风需要 HTTPS（反代证书）；安卓 APK 壳无需 HTTPS。"
