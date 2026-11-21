# dsh-rinko-nai · 安装说明（3 步）

> DSH 插件：在 DSH 里直接用 **YesNAI（nai.rinko.ai）** 出图，设置页带登录 / 余额 / 图包 / 站内画廊 / 流水。

## 一、把插件放进 DSH

把整个 `dsh-rinko-nai` 文件夹放到：

```
<DSH_HOME>\plugins\dsh-rinko-nai
```

（Windows 默认 `C:\Users\<你>\AppData\Roaming\dsh-desktop\harness\plugins\`）

## 二、在 profile 里登记

打开 `<DSH_HOME>\profiles\web\package.json`，改两处：

```jsonc
{
  "dependencies": {
    // ...原有的...
    "dsh-rinko-nai": "link:../../plugins/dsh-rinko-nai"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...原有的...
        "dsh-rinko-nai"
      ]
    }
  }
}
```

## 三、建链接 + 重启

```powershell
# 建立 node_modules 链接（Windows 用 Junction，不需要管理员）
New-Item -ItemType Junction `
  -Path "<DSH_HOME>\profiles\web\node_modules\dsh-rinko-nai" `
  -Target "<DSH_HOME>\plugins\dsh-rinko-nai"
```

然后**重启 DSH**。

> **Linux / Android(Termux) 等**：不用手动 Junction，一条命令即可（DSH 会自己链好）：
> ```bash
> dsh plugin --profile web add /path/to/dsh-rinko-nai
> ```
> 然后重启 DSH。

## 用起来

1. 设置 → **Rinko NAI** → 输入 YesNAI 账号密码 → 「登录并自动建 Key」
   - 没有账号去 https://nai.rinko.ai 注册
   - 登录后插件会在网站「API 密钥」里自动建一把 `dsh-rinko-nai` 的 Key
2. 对话里说「画一张 …」即可；或直接调工具 `rinko_nai_image`
3. 同一页面还能看：Gems 余额 / 图包剩余 / 站内画廊 / Gems 流水

## 凭据安全

- 凭据**只存在本机** `<DSH_HOME>\rinko-nai\config.json`，不经过第三方。
- 设置页只显示掩码（`ynai-xxxx…abcd`），不回显明文。
- 本安装包**不含任何账号密码**。

详细说明见 `README.md`。
