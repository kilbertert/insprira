#!/usr/bin/env bash
# insprira 本地后台启动脚本
# 用法: ./start.sh {start|stop|restart|status|logs}
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="insprira"
PID_FILE="app.pid"
LOG_FILE="server.log"
MAIN="server.js"
START_GRACE_SEC=2
STOP_TIMEOUT_SEC=10

if [[ -t 1 ]]; then
    GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
else
    GREEN=''; YELLOW=''; RED=''; NC=''
fi

info()  { printf "%s[INFO]%s  %s\n"  "$GREEN"  "$NC" "$*"; }
warn()  { printf "%s[WARN]%s  %s\n"  "$YELLOW" "$NC" "$*"; }
error() { printf "%s[ERROR]%s %s\n" "$RED"    "$NC" "$*" >&2; }

is_running() {
    [[ -f "$PID_FILE" ]] || return 1
    local pid; pid=$(cat "$PID_FILE" 2>/dev/null) || return 1
    [[ -n "$pid" ]] || return 1
    kill -0 "$pid" 2>/dev/null
}

preflight() {
    if ! command -v node >/dev/null 2>&1; then
        error "未找到 node，请先安装 Node.js >= 20"
        exit 1
    fi
    local major; major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if (( major < 20 )); then
        error "Node 版本过低 (当前 v$major，需要 >= 20)"
        exit 1
    fi

    if [[ ! -f .env ]]; then
        if [[ -f .env.example ]]; then
            cp .env.example .env
            warn "已从 .env.example 创建 .env，请填入 REDFOX_API_KEY 等配置后重新启动"
            exit 1
        else
            error ".env 不存在且无 .env.example 可参考"
            exit 1
        fi
    fi

    if [[ ! -d node_modules ]]; then
        info "未检测到 node_modules，开始安装依赖 (npm install) ..."
        npm install
    fi
}

do_start() {
    if is_running; then
        warn "$APP_NAME 已在运行 (PID $(cat "$PID_FILE"))"
        return 0
    fi

    preflight

    info "启动 $APP_NAME ..."
    nohup node "$MAIN" >>"$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    sleep "$START_GRACE_SEC"
    if kill -0 "$pid" 2>/dev/null; then
        info "$APP_NAME 已启动 (PID $pid)，日志：$LOG_FILE"
    else
        error "$APP_NAME 启动失败，最近 30 行日志："
        tail -n 30 "$LOG_FILE" >&2 || true
        rm -f "$PID_FILE"
        exit 1
    fi
}

do_stop() {
    if ! is_running; then
        warn "$APP_NAME 未在运行"
        rm -f "$PID_FILE"
        return 0
    fi
    local pid; pid=$(cat "$PID_FILE")
    info "停止 $APP_NAME (PID $pid) ..."
    kill "$pid" 2>/dev/null || true

    local waited=0
    while (( waited < STOP_TIMEOUT_SEC * 2 )); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
        waited=$((waited + 1))
    done

    if kill -0 "$pid" 2>/dev/null; then
        warn "${STOP_TIMEOUT_SEC}s 内未退出，发送 SIGKILL"
        kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    info "已停止"
}

do_status() {
    if is_running; then
        info "$APP_NAME 运行中 (PID $(cat "$PID_FILE"))"
    else
        warn "$APP_NAME 未运行"
        return 1
    fi
}

do_logs() {
    if [[ ! -f "$LOG_FILE" ]]; then
        warn "日志文件 $LOG_FILE 不存在"
        return 0
    fi
    info "实时跟踪 $LOG_FILE (Ctrl+C 退出)"
    tail -n 100 -f "$LOG_FILE"
}

case "${1:-}" in
    start)   do_start ;;
    stop)    do_stop ;;
    restart) do_stop; do_start ;;
    status)  do_status ;;
    logs)    do_logs ;;
    "")
        error "缺少子命令"
        ;&
    *)
        cat <<EOF
用法: $0 {start|stop|restart|status|logs}
  start    后台启动 (nohup + PID 文件)
  stop     停止 (先 SIGTERM，超时再 SIGKILL)
  restart  重启
  status   查看运行状态
  logs     实时查看日志 (tail -f, Ctrl+C 退出)
EOF
        exit 1
        ;;
esac
