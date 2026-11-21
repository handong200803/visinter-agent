# VisInter-Agent 云端后端镜像（Node 22 自带 node:sqlite，零第三方依赖）
FROM node:22-alpine

# 后处理需要 ffmpeg（minterpolate 插帧）
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY cloud ./cloud
COPY spec ./spec
COPY tools ./tools

# 持久化目录（Render/Fly 需挂盘到 /data）
ENV DATA_DIR=/data
ENV PORT=8787
VOLUME ["/data"]
EXPOSE 8787

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "cloud/server.mjs"]
