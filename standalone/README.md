# Deepscord 独立服务端

Windows x64 测试包，包含 Node.js 和可选 LiveKit 屏幕转发服务。房间服务支持当前客户端的服务器、域、频道、权限、文字、图片、表情、电台和加密内容存储。

## 新建服务器

1. 将完整压缩包解压到服务器上的固定目录。
2. 双击 `start-server.cmd`。首次启动会生成 `server.env`、`certs/` 和 `data/`。
3. 在 Windows 防火墙和云服务器安全组中放行 TCP 3443。若修改 `HTTPS_PORTS`，对应调整端口。
4. 客户端选择“加入服务器 → 自建服务器”，填写 `https://服务器地址:3443`。加入口令是 `server.env` 中的 `ECHO_PASSWORD`。
5. 首次连接时核对证书指纹。需要成为服主的用户在“服务器与域管理”中填写 `data/owner-claim.txt` 的认领码。成功认领后，该文件会删除。

默认语音由成员直连，屏幕采用用户转发。遇到无法直连的网络，可按随包的 `NETWORKING.md` 配置 STUN/TURN。配置修改后重启对应服务。

## 升级已有服务器

1. 停止旧房间服务及已运行的屏幕转发服务，保留一份完整旧目录作为备份。
2. 把新包解压到另一个目录，将旧目录的 `server.env`、整个 `certs/` 和整个 `data/` 复制到新目录。需要同时保留频道、权限、图片、会话密钥和证书。
3. 如果 `ECHO_DATA_DIR` 指向自定义目录，继续使用原目录或在复制后更新该配置。其他自定义证书路径也要检查。
4. 在新目录运行 `start-server.cmd`，核对频道、历史和服主权限，再开放给成员使用。

保留原证书可沿用客户端已确认的指纹。若服务运行后需要回退，停止新服务并使用升级前保存的整套目录和数据。

## 使用服务器转发屏幕

在房间服务停止时配置 `server.env`。

```ini
ECHO_SCREEN_MODE=sfu
ECHO_SCREEN_SFU_URL=wss://服务器地址:3443/screen-sfu
LIVEKIT_NODE_IP=服务器公网IP
LIVEKIT_UDP_PORT=7882
LIVEKIT_TCP_PORT=7881
```

首次启用时在服务端目录执行以下命令，已有 SFU 密钥的服务器继续使用原配置。

```powershell
.\runtime\node.exe .\deploy\livekit-config.cjs init server.env
```

放行 UDP 7882 和 TCP 7881。启动 `start-screen-sfu.cmd`，再启动 `start-server.cmd`，保持两个服务运行。LiveKit 的 7880 端口只用于本机信令与管理，公网访问通过房间服务的 `/screen-sfu` 路径。语音中继仍由独立的 TURN 配置决定。

## 数据与加密

房间内容加密由服主在 Windows 客户端主动启用。升级程序后，已有房间仍保留其原来的加密状态。内容密钥由客户端保存，服务端程序包不包含成员的内容密钥。

`server.env`、`certs/`、`data/` 和 `logs/` 属于运行期间的私有文件，备份时单独保管。完整网络模式、证书与加密说明见发行包根目录的 `NETWORKING.md`，也可查阅[仓库中的网络说明](https://github.com/An1X3R/deepscord/blob/main/NETWORKING.md)。
