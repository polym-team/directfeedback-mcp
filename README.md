# @polym-team/directfeedback-mcp

**Storybook에 남긴 UI 피드백을 Claude가 직접 읽고 고치게 해주는 MCP 서버입니다.**

DirectFeedback으로 스토리북 화면의 특정 엘리먼트에 코멘트를 남기면, Claude가
그 코멘트를 조회해서 → 해당 컴포넌트 소스를 찾아 수정하고 → 코멘트를 해결 처리하는
흐름을 만들 수 있습니다.

> **지금 지원 범위**
> - 대상: **Storybook** (스토리 화면에 남긴 피드백)
> - 클라이언트: **Claude / Claude Code** (MCP)
>
> 다른 사이트·에이전트 지원은 이후 확장 예정입니다.

## 시작하기

### 1. 로그인 (최초 1회)

```bash
npx @polym-team/directfeedback-mcp login
```

브라우저가 열리면 Polymorph 통합 계정(구글/카카오)으로 로그인하세요. 로그인 정보는
`~/.config/directfeedback-mcp/tokens.json`에 안전하게 저장되고, 이후 자동으로 갱신됩니다.
(별도의 API 키나 토큰을 직접 넣을 필요가 없습니다.)

> 피드백을 보려면 해당 피드백 **그룹의 멤버**여야 합니다. 그룹 초대는 DirectFeedback
> 관리자에게 문의하세요.

### 2. Claude Code에 연결

```bash
claude mcp add directfeedback -- npx -y @polym-team/directfeedback-mcp
```

또는 프로젝트 `.mcp.json`에 직접:

```json
{
  "mcpServers": {
    "directfeedback": {
      "command": "npx",
      "args": ["-y", "@polym-team/directfeedback-mcp"]
    }
  }
}
```

비밀값이 들어가지 않으므로 `.mcp.json`을 저장소에 커밋해도 됩니다.

### 3. 사용

Claude Code에서 이렇게 요청하면 됩니다:

> "미해결 피드백 확인하고 하나씩 고쳐줘"

Claude가 미해결 코멘트를 조회해서, 각 코멘트의 스토리(urlKey)와 엘리먼트 정보로
소스를 찾아 수정하고, 완료되면 코멘트를 해결 처리합니다.

## 제공 도구

| 도구 | 설명 |
|---|---|
| `list_unresolved_comments` | 내 그룹의 미해결(OPEN) 코멘트를 스토리·엘리먼트·본문과 함께 조회 |
| `resolve_comment` | 코멘트를 해결됨으로 표시 |
| `add_reply` | 코멘트에 답글 작성 |
| `create_comment` | 스토리에 새 코멘트 생성(역방향 피드백/노트). 기본은 스토리 레벨, `cssPath`로 특정 엘리먼트 지정 가능 |

## 로그아웃

```bash
npx @polym-team/directfeedback-mcp logout
```

## 문제 해결

- **"로그인이 필요합니다"가 나와요** → `npx @polym-team/directfeedback-mcp login`을 다시 실행하세요.
- **코멘트가 안 보여요** → 로그인한 계정이 해당 피드백 그룹의 멤버인지 확인하세요.
- **브라우저가 자동으로 안 열려요** → 터미널에 출력된 URL을 직접 열어 로그인하세요.

## 고급 설정 (선택)

기본값은 Polymorph 프로덕션을 가리킵니다. 로컬/자체 백엔드로 붙일 때만 환경변수로 바꿉니다.

| 변수 | 기본값 |
|---|---|
| `DIRECTFEEDBACK_API` | `https://directfeedback.polymorph.co.kr` |
| `OAUTH_ISSUER` | `https://oauth.polymorph.co.kr` |

## 요구 사항

- Node.js 18 이상
