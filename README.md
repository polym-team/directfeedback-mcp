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

**모든 프로젝트에서 쓰려면 `user` 스코프로 등록하세요** (권장):

```bash
claude mcp add -s user directfeedback -- npx -y @polym-team/directfeedback-mcp
```

> ⚠️ `-s user`를 빼면 기본 스코프가 `local`이라 **명령을 실행한 그 디렉토리에서만** MCP가
> 잡힙니다. 다른 프로젝트 폴더에서 Claude Code를 열면 도구가 안 보이게 됩니다.
> 어느 폴더에서 실행하든 `-s user`면 전역으로 등록됩니다.
> (로그인 토큰은 `~/.config/directfeedback-mcp/tokens.json`에 저장되어 이미 전역이므로,
> 등록만 user 스코프로 하면 됩니다. login은 폴더 상관없이 한 번만 하면 됩니다.)

특정 프로젝트에서 팀과 공유하려면 그 프로젝트의 `.mcp.json`에 직접 넣어 커밋해도 됩니다
(비밀값이 없어 안전):

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
| `create_comment` | 스토리에 새 코멘트 생성(역방향 피드백/노트). `urlKey`·`body`·`pageUrl`(버전/빌드 추적용 정확한 스토리북 URL) 필수, `cssPath`로 특정 엘리먼트 지정 가능 |
| `get_tobe` | 스토리의 To-Be(디자이너가 그린 원본 대비 변경)를 `{selector, kind, property, from, to}` 목록 + 스토리북 버전으로 반환. 소스에 반영하는 데 사용 |
| `resolve_tobe` | 반영 후 그 스토리의 진행 중 To-Be를 완료 처리(디자이너가 새 스냅샷을 다시 만들 수 있게) |

## 로그아웃

```bash
npx @polym-team/directfeedback-mcp logout
```

## 완전 삭제 후 재설치

꼬였을 때(스코프 실수, 토큰 문제 등)는 아래로 깨끗이 지우고 다시 설치하세요.

```bash
# 1) 로그아웃 — refresh token 폐기 + 로컬 토큰 파일 삭제
npx @polym-team/directfeedback-mcp logout

# 2) MCP 등록 해제 — 등록했던 스코프에 맞춰 실행 (user로 넣었으면 -s user)
claude mcp remove -s user directfeedback
#   local 스코프로 넣었던 경우: 해당 프로젝트 폴더에서
#   claude mcp remove directfeedback

# 3) 혹시 남은 토큰/캐시 수동 삭제 (선택)
rm -rf ~/.config/directfeedback-mcp

# 4) 다시 설치
npx @polym-team/directfeedback-mcp login
claude mcp add -s user directfeedback -- npx -y @polym-team/directfeedback-mcp
```

> 여러 스코프에 중복 등록했는지 확인: `claude mcp list`

## 문제 해결

- **어떤 폴더에서는 도구가 안 보여요** → `local` 스코프로 등록된 겁니다. `-s user`로 다시 등록하세요
  (`claude mcp list`로 확인). 로그인은 전역이라 다시 할 필요 없습니다.
- **`npm error EOVERRIDE` / npx 실행이 프로젝트 npm 설정과 충돌해요** → 그 프로젝트 package.json 의
  `overrides` 등이 npx 설치를 막는 경우입니다. **전역 설치로 우회**하세요(프로젝트 무관):
  ```bash
  npm i -g @polym-team/directfeedback-mcp
  directfeedback-mcp login
  claude mcp add -s user directfeedback -- directfeedback-mcp
  ```
  또는 로그인만 홈에서: `cd ~ && npx @polym-team/directfeedback-mcp login`.
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
