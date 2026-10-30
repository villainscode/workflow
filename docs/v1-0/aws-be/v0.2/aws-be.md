# API staging CI/CD 구축 런북

> 기준 자료: `docs/deploy/aws-be-onboarding.html`(2026-10-16 판) 07~12장, PR #58(`refactor/staging-prod-separation`)의 `docs/deployment-environments.md` · `terraform/README.md` · `terraform/environments/staging/README.md`.
> 이 문서는 위 기준을 그대로 따라 **staging 인프라 → 앱 자동 배포 → 검증 · 복구 연습**까지 순서대로 진행할 수 있게 정리한 실행 절차다.
>
> **2026-10-19 현재: Step 7-A(첫 배포)까지 완료.** `https://api-staging.habilis-console.com` 에서 API · Swagger 가 사무실망으로 열린다. 진행 기록은 0-5, 실제로 겪은 문제와 해결은 10-B, 허용 IP 추가는 13장.
> 아래 Step 2 · 3 · 5 · 6 의 코드 블록은 `origin/develop`(`2172963`)의 실제 파일과 같다. 다시 맞출 때는 저장소 파일이 원본이다.

---

## 0. 먼저 알아둘 것

### 0-1. 이 문서가 확인한 것 / 확인하지 못한 것

| 항목 | 상태 |
|---|---|
| 온보딩 문서 07~12장의 요구사항 | 전부 반영 |
| PR #58 의 staging 프로필 · 필수 환경변수 · 디렉터리 구조 | 브랜치 코드로 확인 |
| 기존 prod 배포(CD · Infra CD · ASG · user-data) | 코드로 확인 |
| 아래 Terraform · 워크플로 · 스크립트 코드 | **develop 에 머지된 실제 파일과 같다**(PR #62 · #65). `terraform validate`(v1.16.6) · `actionlint` · `shellcheck` 통과, Infra staging plan/apply · Deploy staging 실제 실행 성공 |
| AWS 실제 상태(역할 · 인스턴스 프로필 · 인증서 · 서브넷 · IP 충돌) | **2026-10-19 조회 완료** — 0-C 「조회 결과」. 막혔던 것(인증서 만료, OIDC trust `ref=main`, infra 역할 권한 3건)은 모두 관리자 처리 완료 |
| 외부(사무실망) 확인 | `/health` · Swagger 열림 확인(사용자). CORS · 차단 · DB TLS · 복구 연습은 아직 |

### 0-2. prod 와 staging 의 배포 방식 차이

| | prod (현재 · 유지) | staging (이번에 구축) |
|---|---|---|
| Terraform 루트 | `terraform/environments/prod/` (PR #58 이후) | `terraform/environments/staging/` (새로 작성) |
| State | `habilis-infra-tfstate/habilis-api-server/terraform.tfstate` | `habilis-infra-tfstate/habilis-api-server-staging/terraform.tfstate` |
| 네트워크 | VPC `10.0.0.0/16` | 기존 VPC `10.101.0.0/16` 재사용 |
| 앱 서버 | ASG 2대(t4g.small), 인스턴스 교체 배포 | EC2 1대 `10.101.0.110`(t4g.medium), **컨테이너만 교체** |
| 배포 트리거 | `CD` dispatch(patch/minor/major/rollback) 또는 `v*` 태그 | `develop` push 자동 + 수동 rollback dispatch |
| 이미지 | ECR `habilis-api-api`, `vX.Y.Z` + `latest` | ECR `habilis-api-staging-api`, `sha-<40자리 커밋>` (immutable) |
| 서버에 이미지 반영 | SSM 파라미터 갱신 → instance refresh → 부팅 시 user-data 가 pull | **SSM Run Command** 로 `/opt/app/deploy.sh` 실행 |
| AWS 인증 | GitHub Secret 의 정적 키(`AWS_ACCESS_KEY`) | **GitHub OIDC** (`habilis-api-staging-infra` · `-deploy` 역할) |
| ALB 접근 | `0.0.0.0/0` | 사무실 · 회사 VPN 고정 공인 IP 만 |
| Spring 프로필 | `prod` | `staging` |
| 시크릿 | `habilis-api/prod/infra` | `habilis-api/staging/infra` |
| 무중단 | 예 (TG drain 30s · graceful 20s) | **아니오** — 서버 1대라 교체 중 502/503 이 잠깐 난다 |

### 0-3. 전체 흐름

```
[인프라]
 PR (terraform/environments/staging/**)
   └─ Infra staging 워크플로: fmt · validate (AWS 인증 없음)
 develop 머지
   └─ 수동 dispatch (develop, apply=false) → plan 확인
   └─ 수동 dispatch (develop, apply=true)  → apply

[앱]
 PR → 기존 CI (build · test)
 develop 머지
   └─ Deploy staging 워크플로 (자동)
        test → Jib arm64 이미지 → ECR :sha-<commit>
        → SSM Run Command → /opt/app/deploy.sh sha-<commit>
             ECR pull → 컨테이너 교체 → 서버 내부 readiness 확인
             실패 시 직전 이미지로 자동 복구 → 워크플로 실패
        → 성공 시 SSM /habilis-api/staging/image-tag 기록
 staging 검증 후 → 기존 prod CD 를 dispatch (지금과 동일)
```

### 0-4. 이 저장소의 규칙 중 이 작업에 걸리는 것

- `terraform/**` · `.github/workflows/**` 변경은 사용자 승인 대상이다(`.claude/rules/safety.md`). 에이전트에게 맡길 때 명시적으로 승인한다.
- **로컬에서 `terraform plan` · `apply` 를 하지 않는다.** 로컬은 `init -backend=false` + `validate` 까지만. plan/apply 는 워크플로로.
- prod 자원 · prod 시크릿 · prod 키를 staging 에 복사하지 않는다.
- 패키지 이동과 동작 변경을 한 PR 에 섞지 않는다 → 이 작업은 PR 3개로 나눈다(11장).

### 0-5. 진행 현황 (2026-10-19)

| # | 단계 | 결과 | 근거 |
|---|---|---|---|
| 0-A | PR #58 (환경 분리) | ✅ main 머지 `1383039`, develop 생성 | — |
| — | CI 를 develop PR 에도 · 필수 체크 `build` 항상 보고 | ✅ PR #59 | 10-B ⑮ |
| — | 룰셋 `protect-develop-main`(id 25228140) | ✅ develop · main 에 PR 필수 · squash · `build` 필수 · 선형 이력 · 삭제/force push 금지 | bypass 가 `always` — `pull requests only` 권장(사용자 설정) |
| 0-C | 기존 자원 조회 | ✅ | 0-C 표 |
| 0-D | 사무실 출구 IP | ⚠️ 임시 6개 등록 — 네트워크 담당자 공식 목록 대기 | 10-B ⑬, 13장 |
| 0-F | GitHub Environment `staging` | ✅ develop 만 허용 · 변수 7개 | 0-F 표 |
| 1 | ACM 재발급 · DNS 검증 | ✅ `dfe959e6-…` ISSUED 14:20 KST | Step 1 |
| — | 관리자 요청 3건(trust ref develop · Secrets Manager 2개 · RDS 옵션 그룹) | ✅ 처리 완료 | 10-B ⑥ ⑩ |
| 2 · 3 | Terraform · `infra-staging.yml` | ✅ PR #62 (`5eaae1f`) | — |
| 4 | plan / apply | ✅ plan run `39213109100`(44 add · 0 change · 0 destroy) → apply run `39213499201`(44 added, 약 10분) | Step 4 |
| 5 · 6 | `deploy/staging/**` · `deploy-staging.yml` | ✅ PR #63 → 되돌림 #64 → 재추가 PR #65 (`2172963`) | 10-B ⑪ |
| 7-A | 첫 배포 | ✅ run `39222918691`(약 4분), 이미지 `sha-2172963fc114c2ff55f7e72c135a79791c335e06`, TG `healthy` | Step 7-A |
| 7-B | 정상 동작 확인 | 🔶 `/health` · Swagger 확인. 가입/로그인 · rate limit · CORS 미확인 | — |
| 7-C · 7-D | 차단 · DB TLS | ⬜ | — |
| 8 | 복구 연습 | ⬜ | — |
| 9 | 프런트 연동 | ⬜ | — |

**만들어진 자원 (apply outputs)**

| 항목 | 값 |
|---|---|
| EC2 | `i-0d487e887a65be933` · `habilis-api-staging-server` · `10.101.0.110` · 공인 `43.203.205.119` · t4g.medium · `ami-0171e38cc88437aa1` |
| ALB | `habilis-api-staging-alb-446377036.ap-northeast-2.elb.amazonaws.com` |
| 대상 그룹 | `arn:aws:elasticloadbalancing:ap-northeast-2:668826142093:targetgroup/habilis-api-staging-tg/344d6e613d4b9542` |
| RDS | `habilis-api-staging-db.c5gycogs2zrd.ap-northeast-2.rds.amazonaws.com` · DB SG `sg-064e23250d0fc38f1` |
| Valkey | `habilis-api-staging-redis.79ciiq.ng.0001.apn2.cache.amazonaws.com` |
| ECR | `668826142093.dkr.ecr.ap-northeast-2.amazonaws.com/habilis-api-staging-api` |
| 시크릿 · 파라미터 · 로그 | `habilis-api/staging/infra` · `/habilis-api/staging/image-tag` · `/habilis-api/staging/app` |
| 인증서 | `arn:aws:acm:ap-northeast-2:668826142093:certificate/dfe959e6-3ef6-48f3-bbe3-7ec56387ed1b` |

**상시 비용이 나는 자원**: EC2 · RDS · Valkey · ALB. 쓰지 않는 기간이 길면 정리 방법을 관리자와 정한다(RDS 는 삭제 보호 + 마지막 스냅샷).

---

## Step 0. 선행 조건 확인

### 0-A. PR #58 머지 확인 — ✅ 완료 (2026-10-16)

> **이 런북의 기준(2026-10-19 확정)**: 도메인 `api-staging.habilis-console.com`(온보딩 문서와 같음), staging 배포 브랜치 **`develop`**(온보딩 문서의 `main` 과 다름 — `main` 은 prod 용). 브랜치 룰셋 `protect-develop-main` 이 `develop` · `main` 에 PR 필수 · `build` 필수 체크를 건다.

PR #58 은 `main` 에 머지됐고(`1383039`), `develop` 은 그 위에서 만들었다. staging 프로필 · `terraform/environments/` 구조가 `develop` 에 있다.

```bash
git switch develop && git pull --ff-only
ls terraform/environments/          # prod  staging
grep -n '"staging"' src/main/resources/config/application.yaml   # profiles.group 에 staging 존재
```

### 0-B. 로컬 도구 · AWS 프로필

```bash
# 도구 — 없으면 설치
brew install hashicorp/tap/terraform actionlint shellcheck
terraform version     # >= 1.10 (S3 native lock 사용)

# 조회용 default(읽기 전용) · 설정용 개인 프로필
aws sts get-caller-identity                    # default = namhee-readonly
aws sts get-caller-identity --profile namhee   # arn:aws:iam::668826142093:user/namhee@tommoro.ai
```

`AWS_PROFILE=namhee` 를 전역으로 걸지 않는다. 변경 명령에만 `--profile namhee` 를 붙인다.

### 0-C. 기존 자원 조회 (전부 읽기 전용)

아래를 돌려 결과를 PR 설명에 붙인다.

```bash
export AWS_REGION=ap-northeast-2
VPC=vpc-042a327fbaefcf89e

# 1) VPC · edge 서브넷이 문서와 같은지
aws ec2 describe-vpcs --vpc-ids $VPC --query 'Vpcs[0].CidrBlock' --output text
#   기대: 10.101.0.0/16
aws ec2 describe-subnets --subnet-ids subnet-00a7228f88f972f04 \
  --query 'Subnets[0].[CidrBlock,AvailabilityZone,MapPublicIpOnLaunch]' --output text
#   기대: 10.101.0.0/24  ap-northeast-2a  True

# 2) 새로 만들 240~243 대역이 비어 있는지
aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC \
  --query 'Subnets[].[CidrBlock,AvailabilityZone,Tags[?Key==`Name`]|[0].Value]' --output table
#   기대: 10.101.240~243.0/24 가 목록에 없다

# 3) API 예약 범위 .110~.200 에 이미 쓰는 IP 가 없는지 (primary · secondary 모두)
aws ec2 describe-network-interfaces --filters Name=vpc-id,Values=$VPC \
  --query 'NetworkInterfaces[].PrivateIpAddresses[].PrivateIpAddress' --output text \
  | tr '\t' '\n' | grep -E '^10\.101\.0\.(1[1-9][0-9]|200)$'
#   기대: 출력 없음. 출력이 있으면 기존 자원을 옮기지 말고 주소 계획을 조정한다

# 4) IGW
aws ec2 describe-internet-gateways --filters Name=attachment.vpc-id,Values=$VPC \
  --query 'InternetGateways[].InternetGatewayId' --output text

# 5) 서울 리전 ACM 인증서
aws acm describe-certificate \
  --certificate-arn arn:aws:acm:ap-northeast-2:668826142093:certificate/01bce950-fffa-456e-bf1c-2c131cccdcc7 \
  --query 'Certificate.[DomainName,Status]' --output text
#   기대: api-staging.habilis-console.com  ISSUED  (2026-10-19 현재 VALIDATION_TIMED_OUT → Step 1 재발급)

# 6) GitHub OIDC 역할 2개 — 존재 · 신뢰 조건 · 붙은 정책
for R in habilis-api-staging-infra habilis-api-staging-deploy; do
  echo "== $R"
  aws iam get-role --role-name $R --query 'Role.AssumeRolePolicyDocument' --output json
  aws iam list-attached-role-policies --role-name $R --output table
  aws iam list-role-policies --role-name $R --output table
done

# 7) EC2 인스턴스 프로필 · 역할 정책
aws iam get-instance-profile --instance-profile-name habilis-api-staging-ec2-profile \
  --query 'InstanceProfile.Roles[].RoleName' --output text

# 8) 이름 충돌 — 이미 누가 만들어 둔 자원이 있는지 (있으면 Terraform 생성이 실패한다)
aws ecr describe-repositories --repository-names habilis-api-staging-api 2>&1 | head -3
aws secretsmanager describe-secret --secret-id habilis-api/staging/infra 2>&1 | head -3
aws logs describe-log-groups --log-group-name-prefix /habilis-api/staging --query 'logGroups[].logGroupName'
aws ssm get-parameter --name /habilis-api/staging/image-tag 2>&1 | head -3
```

**조회 결과 (2026-10-19, default 읽기 전용 프로필)**

| 항목 | 결과 | 조치 |
|---|---|---|
| 1) VPC · edge 서브넷 | `10.101.0.0/16` · `10.101.0.0/24` 2a 일치. 단 `MapPublicIpOnLaunch=False` | 없음 — `ec2.tf` 가 `associate_public_ip_address = true` 로 직접 지정 |
| 2) 240~243 대역 | 비어 있음(기존 서브넷은 `.0/24` edge · `.3/24` cch 뿐) | 없음 |
| 3) .110~.200 | 비어 있음(`.100` = admin-console, `.243` = gateway) | 없음 |
| 4) IGW | `igw-050f287f7e5492e07` | 없음 |
| 5) ACM `01bce950-…` | **`VALIDATION_TIMED_OUT`** — 검증 CNAME 이 72시간 안에 등록되지 않아 만료 | ✅ 재발급 `dfe959e6-…` ISSUED, 옛 인증서 삭제 → Step 1 |
| 6) OIDC 역할 2개 | 있음. 저장소 · 조직 · `environment:staging` 조건 일치. **`ref = refs/heads/main`** | ✅ 관리자가 `refs/heads/develop` 으로 수정 |
| 6) infra 역할 정책 | 6개(Runtime · Services · Network · Read · SingleHost · Config). Route 53 은 `api-staging` A/AAAA · `_*.api-staging` CNAME 한정, ACM 은 `ListCertificates` + 위 인증서 ARN 한정 | 재발급 ARN 으로 `HabilisApiStagingConfig` 의 `ManageBootstrapCertificate` 교체 요청 |
| 6) deploy 역할 | `ssm:SendCommand` 조건 = 태그 `Project=habilis-api` · `Environment=staging` · **`Name=habilis-api-staging-server`** | 서버 `Name` 태그를 이 값으로 고정(ec2.tf 그대로) |
| 7) 인스턴스 프로필 | `habilis-api-staging-ec2-profile` → `habilis-api-staging-ec2-role`(SSM Core · ECR pull · image-tag · 시크릿 · `/habilis-api/staging/app` 로그) | 없음 |
| 8) 이름 충돌 | ECR · 시크릿 · RDS · 캐시 · ALB · tfstate 모두 없음 | 없음 |
| 개인 계정 `namhee` | 그룹 `habilis-api-staging-operators` 로 infra 역할과 같은 정책 묶음 + 세션(Operator). `acm:RequestCertificate` · IAM 수정 권한은 없음 | 검증 CNAME 등록(Step 1)은 직접 가능 |

**판정 기준**

| 결과 | 조치 |
|---|---|
| 6) 역할이 없음 | 역할 생성은 cch(관리자) 담당. 요청하고 대기 |
| 6) 신뢰 정책에 `environment:staging` · 저장소 ID `1263495771` · `refs/heads/develop` 조건이 없음 | 관리자에게 수정 요청 |
| 6) 정책 권한이 아래 「역할별 필요 권한」보다 좁음 | 관리자에게 부족한 Action 목록을 전달 |
| 7) 인스턴스 프로필이 없음 | 관리자에게 요청(아래 권한 포함). 직접 만들지 않는다 |
| 8) 이미 존재 | Terraform 에서 `data` 로 참조하거나 `import` 블록으로 가져온다 — 어느 쪽인지 관리자와 정한다 |

**역할별 필요 권한 (관리자에게 전달할 목록)**

| 역할 | 필요한 권한 |
|---|---|
| `habilis-api-staging-infra` | S3 `habilis-infra-tfstate` 의 `habilis-api-server-staging/*` 읽기 · 쓰기(lock 파일 포함), EC2(서브넷 · 라우팅 테이블 · SG · 인스턴스 · 태그), ELBv2, RDS, ElastiCache, ECR(저장소 · lifecycle), Secrets Manager(`habilis-api/staging/*`), SSM 파라미터(`/habilis-api/staging/*`), CloudWatch Logs(`/habilis-api/staging/*`), Route 53 레코드(`api-staging` 한정), ACM 조회, `iam:PassRole`(staging EC2 역할 한정), `iam:GetInstanceProfile` |
| `habilis-api-staging-deploy` | ECR `habilis-api-staging-api` push · `DescribeImages`, `ecr:GetAuthorizationToken`, `ssm:SendCommand`(문서 `AWS-RunShellScript` + 태그 `Environment=staging` 인스턴스 한정), `ssm:GetCommandInvocation`, `ssm:PutParameter`(`/habilis-api/staging/image-tag` 한정) |
| EC2 역할(`habilis-api-staging-ec2-profile`) | `AmazonSSMManagedInstanceCore`, ECR pull(`habilis-api-staging-api`), `secretsmanager:GetSecretValue`(`habilis-api/staging/infra` 한정), `logs:CreateLogStream` · `PutLogEvents`(`/habilis-api/staging/app` 한정) |

### 0-D. 사무실 · VPN 공인 출구 IP 확보

```bash
# VPN 을 켠 상태 · 사무실망에서 각각 실행
curl -s https://checkip.amazonaws.com
```

- 네트워크 담당자에게 **고정 출구 IP 목록**을 확인받는다. 개인 집 IP · 넓은 대역을 임시로 넣지 않는다.
- VPN 을 켜도 인터넷 트래픽이 집 회선으로 나갈 수 있다(split tunnel). VPN 을 켠 상태의 결과가 사무실과 다르면 담당자에게 확인한다.
- 이 값은 저장소에 커밋하지 않고 GitHub Environment 변수(`ALB_ALLOWED_IPV4_CIDRS`)로 넣는다(0-F).

**실제 결과 (2026-10-19)**: 사무실망은 **멀티 WAN** 이라 `curl` 할 때마다 출구 IP 가 바뀐다. 반복 조회로 6개를 확인해 임시 등록했다.

```bash
# 출구 IP 를 여러 번 모은다 (zsh 대신 bash — 10-B ㉑)
bash -c 'for i in $(seq 1 30); do curl -s https://checkip.amazonaws.com; done | sort | uniq -c'
```

`1.234.191.104` · `14.52.169.47` · `14.52.169.245` · `221.148.138.140` · `118.216.68.203` · `116.47.121.148`

- 목록에 없는 출구로 나가면 ALB 접속이 **타임아웃**된다(SG 는 거부 응답 없이 버린다). 간헐적 타임아웃이면 먼저 이 원인을 의심한다.
- **네트워크 담당자에게 공식 출구 IP · 대역을 받아 교체한다** → 13장 절차.

### 0-E. IP 관리대장 · 룸 할당 범위

- IP 관리대장에 `10.101.240.0/24` ~ `10.101.243.0/24`, `10.101.0.110` ~ `10.101.0.200` 예약을 등록한다.
- 룸 할당 코드(`room_index` 허용 범위)에서 240~243 을 제외한 변경이 **서브넷 생성 전에** 반영됐는지 확인한다.

### 0-F. GitHub Environment `staging` 설정 (habilis_api_server 저장소)

> ✅ **2026-10-19 완료.** `staging` 환경은 PR #63 머지 때 워크플로가 **자동 생성**했다(브랜치 제한 없음 상태로 — 10-B ⑫). 이후 custom branch policy 로 `develop` 만 허용하게 고쳤다. 변수 7개 등록 완료.

저장소 관리자 권한이 필요하다. 없으면 관리자에게 요청한다.

1. Settings → Environments → **New environment** → 이름 `staging`(정확히 이 이름).
2. Deployment branches and tags → **Selected branches** → `develop` 만 추가.
3. Environment variables(Secret 아님) 등록:

| 이름 | 값 |
|---|---|
| `AWS_REGION` | `ap-northeast-2` |
| `AWS_INFRA_ROLE_ARN` | `arn:aws:iam::668826142093:role/habilis-api-staging-infra` |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::668826142093:role/habilis-api-staging-deploy` |
| `ECR_REPOSITORY` | `habilis-api-staging-api` |
| `API_BASE_URL` | `https://api-staging.habilis-console.com` |
| `ALB_ALLOWED_IPV4_CIDRS` | `["203.0.113.10/32","198.51.100.20/32"]` 형식(JSON = HCL 리스트). 현재 0-D 의 6개 `/32` |
| `STAGING_INSTANCE_ID` | `i-0d487e887a65be933` (Step 4 apply 후 등록). **비어 있으면 develop push 배포가 `skip` 으로 초록 종료**한다 — 10-B ⑪ |

CLI 로 등록하려면(권한이 있을 때):

```bash
gh api -X PUT repos/Tommoro-AI/habilis_api_server/environments/staging
gh variable set AWS_REGION --env staging --body ap-northeast-2
gh variable set ALB_ALLOWED_IPV4_CIDRS --env staging --body '["203.0.113.10/32"]'
# ... 나머지 동일
gh variable list --env staging

# 브랜치 제한 확인 · 설정 (develop 만)
gh api repos/Tommoro-AI/habilis_api_server/environments/staging --jq '.deployment_branch_policy'
gh api repos/Tommoro-AI/habilis_api_server/environments/staging/deployment-branch-policies --jq '.branch_policies[].name'
```

### 0-G. 작업 브랜치

```bash
git switch develop && git pull --ff-only
git switch -c feat/staging-infra
```

---

## Step 1. 관리자 요청 → ACM 인증서 재발급 · DNS 검증 — ✅ 인증서 완료 (2026-10-19)

> 새 인증서 `arn:aws:acm:ap-northeast-2:668826142093:certificate/dfe959e6-3ef6-48f3-bbe3-7ec56387ed1b` — `ISSUED` 2026-10-19 14:20 KST, 태그 `Project=habilis-api` · `Environment=staging`, 검증 CNAME 등록됨(이름 · 값은 옛 인증서와 같음). 옛 `01bce950-…` 은 삭제됨. 발급 권한은 관리자가 `acm:RequestCertificate` 등을 추가해 개인 계정으로 직접 발급했다. OIDC 역할 2개 trust `ref` → `refs/heads/develop` 도 관리자가 처리했다(2026-10-19).

**직접 발급한 절차(콘솔, `--profile namhee` 계정)**

1. 리전을 **서울(ap-northeast-2)** 로 바꾼다. CloudFront 용(us-east-1)이 아니다.
2. ACM → 인증서 요청 → 퍼블릭 인증서 → 도메인 `api-staging.habilis-console.com` · DNS 검증 · RSA 2048.
3. 태그 `Project=habilis-api` · `Environment=staging` 를 **요청 화면에서** 붙인다(권한 조건이 태그를 요구한다).
4. 생성 후 상세 화면의 CNAME 이름 · 값을 Route 53 `habilis-console.com`(Z03987461DD3FGIDHBUFC)에 등록한다. 「Route 53 에서 레코드 생성」 버튼을 써도 된다.
5. 수 분 뒤 `ISSUED` 를 확인한다.

```bash
aws acm describe-certificate --certificate-arn <arn> --query 'Certificate.Status' --output text
dig +short _876fc7f5110d5ea2b35b27a994d82230.api-staging.habilis-console.com CNAME
```

콘솔의 `acm-pca:ListCertificateAuthorities` 오류 배너는 사설 CA 목록 조회 실패일 뿐이다. 퍼블릭 인증서 발급과 무관하다(10-B ③).

온보딩 문서의 인증서(`01bce950-…`)는 `VALIDATION_TIMED_OUT` 이라 CNAME 을 넣어도 살아나지 않는다. 개인 계정에는 `acm:RequestCertificate` 가 없으므로 관리자가 재발급한다.

### 1-A. 관리자 요청 (한 번에)

```
API staging 을 도메인 api-staging.habilis-console.com, 배포 브랜치 develop 기준으로 구축합니다.
(온보딩 문서와 도메인은 같고, 브랜치만 main → develop 입니다. main 은 prod 배포용입니다.)

1. ACM 인증서 재발급 (ap-northeast-2, DNS 검증)
   - 도메인: api-staging.habilis-console.com
   - 기존 01bce950-fffa-456e-bf1c-2c131cccdcc7 은 VALIDATION_TIMED_OUT 이라 삭제해도 됩니다.
   - 새 ARN 을 공유해 주세요. 검증 CNAME 은 제가 namhee 계정으로 등록합니다.

2. 정책 HabilisApiStagingConfig 의 ManageBootstrapCertificate Resource 를 1번 새 인증서 ARN 으로 교체
   (Route 53 레코드 이름 조건은 그대로 두셔도 됩니다)

3. OIDC 역할 trust 조건 수정 — habilis-api-staging-infra, habilis-api-staging-deploy
   - token.actions.githubusercontent.com:ref : "refs/heads/main" → "refs/heads/develop"
   - 나머지 조건(sub = repo:Tommoro-AI/habilis_api_server:environment:staging 등)은 그대로
```

### 1-B. 검증 CNAME 등록 (관리자 1 · 2 반영 후)

```bash
CERT_ARN=<관리자가 준 새 ARN>
ZONE_ID=Z03987461DD3FGIDHBUFC

# 검증 레코드 이름 · 값 조회 (2번 반영 전이면 AccessDenied → 관리자에게 이름 · 값을 받아 아래에 직접 넣는다)
aws acm describe-certificate --certificate-arn "$CERT_ARN" --profile namhee \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord' --output json
# {"Name": "_xxxx.api-staging.habilis-console.com.", "Type": "CNAME", "Value": "_yyyy.acm-validations.aws."}

aws acm describe-certificate --certificate-arn "$CERT_ARN" --profile namhee \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord' --output json \
| jq '{Changes:[{Action:"UPSERT",ResourceRecordSet:{Name:.Name,Type:.Type,TTL:300,ResourceRecords:[{Value:.Value}]}}]}' \
> /tmp/acm-validation.json

aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --change-batch file:///tmp/acm-validation.json --profile namhee

# 수 분 뒤 — 72시간 안에 ISSUED 가 되지 않으면 다시 만료된다
aws acm describe-certificate --certificate-arn "$CERT_ARN" --profile namhee \
  --query 'Certificate.Status' --output text      # ISSUED
```

검증 CNAME 은 자동 갱신에 쓰이므로 지우지 않는다. Terraform 은 `data "aws_acm_certificate"`(도메인 + `ISSUED`)로 이 인증서를 찾으므로 ARN 을 코드에 적지 않는다.

---

## Step 2. staging Terraform 작성

### 2-A. 기존 모듈을 그대로 쓰지 않는 이유 (검토 결과)

온보딩 문서는 "공통 모듈을 검토해 재사용"을 요구한다. `terraform/modules/` 를 검토한 결과 staging 요구와 맞지 않는 부분이 있어, **1차는 staging 루트에 직접 작성하고 모듈 통합은 후속 PR** 로 미룬다. 모듈을 고치면 prod plan 이 바뀌어 운영 위험이 생기기 때문이다.

| 모듈 | staging 요구와 다른 점 |
|---|---|
| `alb` | 인증서를 **새로 발급**한다(`aws_acm_certificate`). staging 은 이미 발급된 인증서를 써야 한다 |
| `rds` | 자체 SG 를 만들고 `admin_ip` 인바운드 · 전체 아웃바운드를 연다. 삭제 보호가 `prod` 에서만 켜진다(staging 은 켜야 함) |
| `redis` | 자체 SG 에 전체 아웃바운드를 연다. SG 이름이 `-redis-sg`(staging 요구는 `-cache-sg`) |
| `asg` | 인스턴스 교체 배포용. staging README 가 "그대로 호출하지 말 것"을 명시 |
| `vpc` | 새 VPC 를 만든다. staging 은 기존 VPC 재사용 |

엔진 메이저(PostgreSQL 16 · Valkey 8.0) · 파라미터 그룹 값 · 백업 시간대는 prod 모듈과 같게 맞춘다.

### 2-B. 파일 구성

```
terraform/environments/staging/
├── README.md            # PR #58 에 있음 — 유지
├── backend.tf
├── versions.tf
├── variables.tf
├── data.tf              # 기존 자원 조회
├── network.tf           # ALB · data 서브넷, 라우팅 테이블
├── security_groups.tf
├── ecr.tf
├── app_env.tf           # 시크릿 · 이미지 태그 파라미터 · 로그 그룹 (secrets.tf 이름은 쓰기 가드가 막는다)
├── rds.tf
├── cache.tf
├── alb.tf
├── ec2.tf
├── user-data.sh
├── outputs.tf
└── .terraform.lock.hcl  # 2-E 에서 생성 후 커밋
```

### 2-C. 코드

> **2026-10-19 — 실제 파일은 develop 의 `terraform/environments/staging/` 가 원본이다(아래 코드 블록은 `2172963` 기준으로 맞춤).** 아래 초안에서 IAM 권한에 맞춰 바꾼 점: `secrets.tf` → `app_env.tf`(쓰기 가드 보호 이름 회피), SG 규칙 `aws_vpc_security_group_*_rule` → `aws_security_group_rule`(규칙 태그 생성 권한 없음), ENI 태그(`aws_ec2_tag`) 제거(생성 후 태그 추가 거부). `terraform validate`(v1.16.6) · `actionlint` · `shellcheck` 통과, provider lock(aws 5.100.0 · random 3.9.1, linux_amd64 · darwin_arm64).
>
> **apply 전에 관리자에게 받은 권한**(정책 원문 기준 누락 → 2026-10-19 추가 완료): `secretsmanager:GetResourcePolicy`(Terraform 이 시크릿을 읽을 때 호출) · `secretsmanager:DeleteSecret`(삭제 시) — 리소스 `habilis-api/staging/infra-??????`; `rds:CreateDBInstance` 의 옵션 그룹 리소스 `arn:aws:rds:ap-northeast-2:668826142093:og:default:postgres-16`.

#### `backend.tf`

```hcl
# staging 전용 state — prod 키(habilis-api-server/terraform.tfstate)와 절대 섞지 않는다.
terraform {
  backend "s3" {
    bucket       = "habilis-infra-tfstate"
    key          = "habilis-api-server-staging/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }
}
```

#### `versions.tf`

```hcl
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0" # prod 루트와 같은 메이저
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
```

#### `variables.tf`

```hcl
variable "aws_region" {
  type    = string
  default = "ap-northeast-2"
}

variable "project_name" {
  type    = string
  default = "habilis-api"
}

variable "environment" {
  type    = string
  default = "staging"

  validation {
    condition     = var.environment == "staging"
    error_message = "이 루트는 staging 전용이다. prod 는 terraform/environments/prod 를 쓴다."
  }
}

variable "vpc_id" {
  type    = string
  default = "vpc-042a327fbaefcf89e"
}

variable "edge_subnet_id" {
  description = "API EC2 를 둘 기존 edge 서브넷(10.101.0.0/24, 2a)"
  type        = string
  default     = "subnet-00a7228f88f972f04"
}

variable "api_private_ip" {
  description = "API EC2 고정 사설 IP — 예약 범위 10.101.0.110~200"
  type        = string
  default     = "10.101.0.110"

  validation {
    condition     = can(regex("^10\\.101\\.0\\.(1[1-9][0-9]|200)$", var.api_private_ip))
    error_message = "API 사설 IP 는 10.101.0.110~10.101.0.200 범위여야 한다."
  }
}

variable "availability_zones" {
  type = map(string)
  default = {
    a = "ap-northeast-2a"
    c = "ap-northeast-2c"
  }
}

variable "alb_subnet_cidrs" {
  type = map(string)
  default = {
    a = "10.101.240.0/24"
    c = "10.101.241.0/24"
  }
}

variable "data_subnet_cidrs" {
  type = map(string)
  default = {
    a = "10.101.242.0/24"
    c = "10.101.243.0/24"
  }
}

# 기본값을 두지 않는다 — GitHub Environment 변수 ALB_ALLOWED_IPV4_CIDRS 가 TF_VAR 로 넣는다.
variable "alb_allowed_ipv4_cidrs" {
  description = "ALB 80·443 허용 출처 — 사무실·회사 VPN 고정 공인 출구 IP"
  type        = list(string)

  validation {
    condition     = length(var.alb_allowed_ipv4_cidrs) > 0
    error_message = "허용 출처가 비어 있다. 사무실·VPN 공인 IP 를 넣는다."
  }

  validation {
    condition     = alltrue([for c in var.alb_allowed_ipv4_cidrs : can(cidrnetmask(c))])
    error_message = "IPv4 CIDR 형식이 아닌 값이 있다(단일 IP 는 /32)."
  }

  # 0.0.0.0/0 같은 넓은 대역을 막는다. 회사 출구가 /24 보다 넓으면 이유를 기록하고 기준을 조정한다.
  validation {
    condition     = alltrue([for c in var.alb_allowed_ipv4_cidrs : tonumber(split("/", c)[1]) >= 24])
    error_message = "/24 보다 넓은 대역(0.0.0.0/0 포함)은 staging 에 허용하지 않는다."
  }
}

variable "root_domain" {
  type    = string
  default = "habilis-console.com"
}

variable "api_domain" {
  type    = string
  default = "api-staging.habilis-console.com"
}

variable "frontend_origin" {
  type    = string
  default = "https://staging.habilis-console.com"
}

variable "ec2_instance_profile_name" {
  description = "관리자가 만든 기존 인스턴스 프로필"
  type        = string
  default     = "habilis-api-staging-ec2-profile"
}

variable "instance_type" {
  description = "초기 t4g.medium — 메모리 사용량을 보고 조정"
  type        = string
  default     = "t4g.medium"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_username" {
  type    = string
  default = "postgres"
}

variable "cache_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "log_retention_days" {
  type    = number
  default = 14
}
```

#### `data.tf`

```hcl
# 기존 자원은 조회만 한다. 이 state 로 가져오거나 바꾸지 않는다.

data "aws_vpc" "staging" {
  id = var.vpc_id

  lifecycle {
    postcondition {
      condition     = self.cidr_block == "10.101.0.0/16"
      error_message = "staging VPC CIDR 이 10.101.0.0/16 이 아니다 — vpc_id 를 확인한다."
    }
  }
}

data "aws_subnet" "edge" {
  id = var.edge_subnet_id

  lifecycle {
    postcondition {
      condition     = self.cidr_block == "10.101.0.0/24" && self.availability_zone == "ap-northeast-2a"
      error_message = "edge 서브넷이 10.101.0.0/24 (2a) 가 아니다."
    }
  }
}

data "aws_internet_gateway" "staging" {
  filter {
    name   = "attachment.vpc-id"
    values = [var.vpc_id]
  }
}

data "aws_route53_zone" "main" {
  name = var.root_domain
}

# ISSUED 가 아니면 plan 이 여기서 실패한다 → Step 1 을 먼저 끝낸다
data "aws_acm_certificate" "api" {
  domain      = var.api_domain
  statuses    = ["ISSUED"]
  most_recent = true
}

data "aws_iam_instance_profile" "ec2" {
  name = var.ec2_instance_profile_name
}

# prod 와 같은 AL2023 표준 에디션(SSM agent 포함) arm64
data "aws_ami" "al2023_arm64" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023*-kernel-*-arm64"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}
```

#### `network.tf`

```hcl
locals {
  name = "${var.project_name}-${var.environment}" # habilis-api-staging
}

# --- ALB 용 public 서브넷 (2a · 2c) ---------------------------------------
resource "aws_subnet" "alb" {
  for_each = var.alb_subnet_cidrs

  vpc_id                  = var.vpc_id
  cidr_block              = each.value
  availability_zone       = var.availability_zones[each.key]
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.name}-alb-${each.key}"
  }
}

# 기존 edge/dev 라우팅 테이블은 건드리지 않고 전용 테이블을 만든다
resource "aws_route_table" "alb" {
  vpc_id = var.vpc_id

  tags = {
    Name = "${local.name}-alb-rt"
  }
}

resource "aws_route" "alb_internet" {
  route_table_id         = aws_route_table.alb.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = data.aws_internet_gateway.staging.id
}

resource "aws_route_table_association" "alb" {
  for_each = aws_subnet.alb

  subnet_id      = each.value.id
  route_table_id = aws_route_table.alb.id
}

# --- RDS · ElastiCache 용 data 서브넷 (2a · 2c) ----------------------------
resource "aws_subnet" "data" {
  for_each = var.data_subnet_cidrs

  vpc_id                  = var.vpc_id
  cidr_block              = each.value
  availability_zone       = var.availability_zones[each.key]
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.name}-data-${each.key}"
  }
}

# VPC local 경로만 — IGW · NAT · gateway 로 가는 기본 경로를 추가하지 않는다
resource "aws_route_table" "data" {
  vpc_id = var.vpc_id

  tags = {
    Name = "${local.name}-data-rt"
  }
}

resource "aws_route_table_association" "data" {
  for_each = aws_subnet.data

  subnet_id      = each.value.id
  route_table_id = aws_route_table.data.id
}
```

#### `security_groups.tf`

Terraform 으로 만든 SG 는 AWS 기본 전체 아웃바운드 규칙이 제거된다. 그래서 DB · 캐시 SG 는 아웃바운드 규칙을 쓰지 않으면 아웃바운드가 없다. 응답은 stateful 이라 나간다. SG 간 참조는 별도 규칙 리소스로 써서 순환 의존을 피한다.

```hcl
# Terraform 으로 만든 SG 는 AWS 기본 전체 아웃바운드 규칙이 제거된다 — DB · 캐시 SG 는 아웃바운드가 없다(응답은 stateful).
# 규칙은 aws_security_group_rule 로 쓴다. aws_vpc_security_group_*_rule 은 default_tags 를 규칙에 붙이는데,
# infra 역할은 AuthorizeSecurityGroup* 시점의 태그 생성(security-group-rule)을 허용하지 않는다.
resource "aws_security_group" "alb" {
  name        = "${local.name}-alb-sg"
  description = "staging ALB - office/VPN only"
  vpc_id      = var.vpc_id
  tags        = { Name = "${local.name}-alb-sg" }
}

resource "aws_security_group" "server" {
  name        = "${local.name}-server-sg"
  description = "staging API EC2 - ALB only"
  vpc_id      = var.vpc_id
  tags        = { Name = "${local.name}-server-sg" }
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db-sg"
  description = "staging RDS - API server only"
  vpc_id      = var.vpc_id
  tags        = { Name = "${local.name}-db-sg" }
}

resource "aws_security_group" "cache" {
  name        = "${local.name}-cache-sg"
  description = "staging Valkey - API server only"
  vpc_id      = var.vpc_id
  tags        = { Name = "${local.name}-cache-sg" }
}

# --- ALB ---------------------------------------------------------------
resource "aws_security_group_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  type              = "ingress"
  description       = "HTTPS from office/VPN egress IP"
  cidr_blocks       = var.alb_allowed_ipv4_cidrs
  protocol          = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_security_group_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  type              = "ingress"
  description       = "HTTP from office/VPN egress IP - redirected to HTTPS"
  cidr_blocks       = var.alb_allowed_ipv4_cidrs
  protocol          = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_security_group_rule" "alb_to_api" {
  security_group_id        = aws_security_group.alb.id
  type                     = "egress"
  description              = "Forward API requests to server"
  source_security_group_id = aws_security_group.server.id
  protocol                 = "tcp"
  from_port                = 8080
  to_port                  = 8080
}

resource "aws_security_group_rule" "alb_to_health" {
  security_group_id        = aws_security_group.alb.id
  type                     = "egress"
  description              = "Readiness health check on management port"
  source_security_group_id = aws_security_group.server.id
  protocol                 = "tcp"
  from_port                = 9090
  to_port                  = 9090
}

# --- API 서버 -------------------------------------------------------------
resource "aws_security_group_rule" "server_api" {
  security_group_id        = aws_security_group.server.id
  type                     = "ingress"
  description              = "API traffic from ALB"
  source_security_group_id = aws_security_group.alb.id
  protocol                 = "tcp"
  from_port                = 8080
  to_port                  = 8080
}

resource "aws_security_group_rule" "server_health" {
  security_group_id        = aws_security_group.server.id
  type                     = "ingress"
  description              = "Readiness check from ALB"
  source_security_group_id = aws_security_group.alb.id
  protocol                 = "tcp"
  from_port                = 9090
  to_port                  = 9090
}

# 초기 staging: 전체 허용. 패키지 · ECR · SSM · AWS API 목적지를 조사한 뒤 좁힌다.
resource "aws_security_group_rule" "server_all" {
  security_group_id = aws_security_group.server.id
  type              = "egress"
  description       = "Initial staging - all outbound, to be narrowed"
  cidr_blocks       = ["0.0.0.0/0"]
  protocol          = "-1"
  from_port         = 0
  to_port           = 0
}

# --- DB · 캐시 ------------------------------------------------------------
resource "aws_security_group_rule" "db_from_server" {
  security_group_id        = aws_security_group.db.id
  type                     = "ingress"
  description              = "PostgreSQL from API server"
  source_security_group_id = aws_security_group.server.id
  protocol                 = "tcp"
  from_port                = 5432
  to_port                  = 5432
}

resource "aws_security_group_rule" "cache_from_server" {
  security_group_id        = aws_security_group.cache.id
  type                     = "ingress"
  description              = "Valkey from API server"
  source_security_group_id = aws_security_group.server.id
  protocol                 = "tcp"
  from_port                = 6379
  to_port                  = 6379
}
```

#### `ecr.tf`

```hcl
# sha-<commit> 태그는 재사용하지 않는다 → IMMUTABLE (같은 태그 덮어쓰기 방지)
resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep last 30 images (rollback window)"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
        action       = { type = "expire" }
      }
    ]
  })
}
```

#### `app_env.tf`

앱 컨테이너 환경변수를 **시크릿 하나(`habilis-api/staging/infra`)에 대문자 키로** 모은다. `deploy.sh` 는 이 JSON 을 그대로 `KEY=VALUE` 로 펼친다. 그래서 RDS · 캐시 엔드포인트가 바뀌어도 다음 배포에 자동 반영되고 user-data 를 고칠 필요가 없다.

비밀번호 · JWT 키는 `random_password` 로 만든다. **이 값들은 state 파일에 평문으로 남는다.** state 버킷은 암호화돼 있지만, 버킷 접근 권한이 관리자 · infra 역할로만 제한돼 있는지 관리자에게 확인한다.

```hcl
resource "random_password" "db" {
  length  = 32
  special = false # RDS 금지 문자(/ @ " 공백) 회피
}

resource "random_password" "jwt" {
  length  = 64
  special = false
}

# 앱 컨테이너 환경변수를 시크릿 하나에 대문자 키로 모은다 — deploy.sh 가 KEY=VALUE 로 펼친다.
# 비밀번호 · JWT 키는 state 에 평문으로 남는다(state 버킷 접근은 관리자 · infra 역할로 제한).
resource "aws_secretsmanager_secret" "app" {
  name                    = "habilis-api/staging/infra"
  description             = "staging API 컨테이너 환경변수 (deploy.sh 가 app.env 로 펼친다)"
  recovery_window_in_days = 7
}

# 키 이름 = 컨테이너 환경변수 이름. 값에 개행을 넣지 않는다(.env 형식이 깨진다 — deploy.sh 가 거부).
resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    SPRING_PROFILES_ACTIVE       = "staging"
    DB_HOST                      = aws_db_instance.main.address
    DB_USER                      = var.db_username
    DB_PASSWORD                  = random_password.db.result
    REDIS_HOST                   = aws_elasticache_replication_group.main.primary_endpoint_address
    REDIS_PORT                   = "6379"
    JWT_SECRET                   = random_password.jwt.result
    CORS_ALLOWED_ORIGIN_PATTERNS = var.frontend_origin
    CONSOLE_BASE_URL             = var.frontend_origin
    AUTH_EMAIL_PROVIDER          = "log"
    SWAGGER_ALLOWED_IPS          = join(",", var.alb_allowed_ipv4_cidrs)
  })
}

# 마지막으로 성공한 배포의 이미지 태그 — 배포 워크플로가 갱신한다
resource "aws_ssm_parameter" "image_tag" {
  name  = "/${var.project_name}/${var.environment}/image-tag"
  type  = "String"
  value = "none"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.project_name}/${var.environment}/app"
  retention_in_days = var.log_retention_days
}
```

`SENTRY_DSN` · `DELIVERY_BASE_URL` 은 쓸 프로젝트 · 서비스가 정해지면 이 JSON 에 추가한다. prod 값을 복사하지 않는다.

#### `rds.tf`

```hcl
resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db-subnet"
  subnet_ids = [for s in aws_subnet.data : s.id] # Single-AZ 여도 두 AZ 서브넷이 필요하다
}

# prod 모듈(terraform/modules/rds)과 같은 값
resource "aws_db_parameter_group" "main" {
  name   = "${local.name}-pg-params"
  family = "postgres16"

  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  parameter {
    name         = "max_connections"
    value        = "200"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "main" {
  identifier = "${local.name}-db"

  engine               = "postgres"
  engine_version       = "16"
  instance_class       = var.db_instance_class
  parameter_group_name = aws_db_parameter_group.main.name

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  username = var.db_username
  password = random_password.db.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  availability_zone      = var.availability_zones["a"]
  publicly_accessible    = false
  multi_az               = false

  # 자동 백업 7일 — UTC 17:00-18:00 = KST 02:00-03:00 (prod 와 동일)
  backup_retention_period = 7
  backup_window           = "17:00-18:00"
  maintenance_window      = "Sun:18:00-Sun:18:30"
  copy_tags_to_snapshot   = true

  # 온보딩 요구: staging 도 삭제 보호 + 마지막 스냅샷
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-db-final"

  auto_minor_version_upgrade = true

  lifecycle {
    ignore_changes = [engine_version]
  }
}
```

PostgreSQL 15 이상 RDS 파라미터 기본값은 `rds.force_ssl=1` 이다. JDBC 기본 `sslmode=prefer` 로 TLS 연결이 된다. prod 와 같은 동작인지 Step 7 에서 `pg_stat_ssl` 로 확인한다.

#### `cache.tf`

```hcl
resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name}-cache-subnet"
  subnet_ids = [for s in aws_subnet.data : s.id]
}

# cluster mode disabled · primary 1 · replica 0 · 자동 장애 전환 끔 (prod 와 같은 구성)
resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.name}-redis"
  description          = "habilis-api staging cache (Valkey)"

  engine               = "valkey"
  engine_version       = "8.0"
  parameter_group_name = "default.valkey8"
  node_type            = var.cache_node_type
  num_cache_clusters   = 1
  port                 = 6379

  preferred_cache_cluster_azs = [var.availability_zones["a"]]
  automatic_failover_enabled  = false
  multi_az_enabled            = false

  # prod 와 일치: 저장 암호화만 켬. 전송 TLS · AUTH 는 prod 도 꺼져 있다.
  # 켜려면 transit_encryption_enabled = true + 시크릿에 REDIS_SSL_ENABLED=true 를 함께 넣고 Step 7 에서 검증한다.
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.cache.id]

  # rate-limit 카운터 전용 — 유실돼도 제한 카운트만 초기화된다(앱은 fail-open). 스냅샷 없음.
  snapshot_retention_limit = 0
  maintenance_window       = "sun:18:00-sun:19:00"

  lifecycle {
    ignore_changes = [engine_version]
  }
}
```

#### `alb.tf`

```hcl
resource "aws_lb" "main" {
  name               = "${local.name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for s in aws_subnet.alb : s.id]

  drop_invalid_header_fields = true
  enable_deletion_protection = false
  # ALB 는 cross-zone 분산이 항상 켜져 있다 (별도 설정 없음)
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "instance"

  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/actuator/health/readiness"
    port                = "9090"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_target_group_attachment" "api" {
  target_group_arn = aws_lb_target_group.api.arn
  target_id        = aws_instance.api.id
  port             = 8080
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06" # prod 와 동일
  certificate_arn   = data.aws_acm_certificate.api.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# IPv4 전용 — AAAA 는 만들지 않는다. EC2 공인 IP 를 DNS 에 넣지 않는다.
resource "aws_route53_record" "api" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.api_domain
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
```

#### `ec2.tf`

```hcl
resource "aws_instance" "api" {
  ami           = data.aws_ami.al2023_arm64.id
  instance_type = var.instance_type

  subnet_id                   = var.edge_subnet_id
  private_ip                  = var.api_private_ip
  associate_public_ip_address = true # 외부로 나가는 통신(ECR · SSM)용. DNS 에는 쓰지 않는다
  vpc_security_group_ids      = [aws_security_group.server.id]
  iam_instance_profile        = data.aws_iam_instance_profile.ec2.name

  metadata_options {
    http_tokens                 = "required" # IMDSv2
    http_put_response_hop_limit = 2          # 컨테이너에서 IMDS 접근
  }

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
    # default_tags 는 루트 볼륨에 전파되지 않는다 → 직접 지정
    tags = {
      Name        = "${local.name}-server"
      Project     = var.project_name
      Environment = var.environment
    }
  }

  # 패키지 설치만 한다. 앱 배포 · 설정은 deploy.sh(SSM) 가 맡는다.
  user_data                   = file("${path.module}/user-data.sh")
  user_data_replace_on_change = false

  tags = {
    Name = "${local.name}-server" # habilis-api-staging-server
  }

  # AMI 갱신 · user-data 수정이 서버 교체(= staging 중단)를 일으키지 않게 한다. 교체가 필요하면 명시적으로 한다.
  lifecycle {
    ignore_changes = [ami, user_data]
  }

  depends_on = [aws_cloudwatch_log_group.app]
}

# 주 네트워크 인터페이스(ENI)에는 태그를 붙이지 않는다 — 생성 후 태그 추가는
# 이미 Project/Environment 태그가 있는 자원에만 허용되므로(HabilisApiStagingNetwork) 거부된다.
```

#### `user-data.sh`

```bash
#!/bin/bash
# staging API 서버 1회 초기화 — 패키지만 설치한다. 앱 배포는 /opt/app/deploy.sh (SSM 으로 전달).
set -euxo pipefail

dnf install -y docker jq
systemctl enable --now docker
# 표준 AL2023 AMI 에는 SSM agent 가 포함돼 있다 — 기동만 보장
systemctl enable --now amazon-ssm-agent

# docker compose v2 플러그인 (AL2023 docker 패키지에 없음)
COMPOSE_VERSION=v2.32.4
PLUGIN_DIR=/usr/libexec/docker/cli-plugins
BASE_URL="https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}"
mkdir -p "$PLUGIN_DIR"
curl -fsSL -o "$PLUGIN_DIR/docker-compose" "$BASE_URL/docker-compose-linux-aarch64"
# shortcut: 같은 출처의 sha256 이라 변조가 아닌 손상만 잡는다. 고정 해시를 박으려면 릴리스 페이지 값으로 교체.
curl -fsSL "$BASE_URL/docker-compose-linux-aarch64.sha256" | awk '{print $1"  '"$PLUGIN_DIR"'/docker-compose"}' | sha256sum -c -
chmod 755 "$PLUGIN_DIR/docker-compose"
docker compose version

install -d -m 750 /opt/app
# 재부팅 후 복구는 docker 의 restart: unless-stopped 가 맡는다 (별도 systemd 유닛 불필요)
```

#### `outputs.tf`

```hcl
output "instance_id" {
  description = "GitHub 변수 STAGING_INSTANCE_ID 에 등록"
  value       = aws_instance.api.id
}

output "instance_public_ip" {
  description = "직접 접근 차단 확인용 (Step 7-C)"
  value       = aws_instance.api.public_ip
}

output "api_url" {
  value = "https://${var.api_domain}"
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "target_group_arn" {
  value = aws_lb_target_group.api.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "cache_primary_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "db_security_group_id" {
  description = "복구 연습(Step 8-D) 의 복원 DB 에 붙일 SG"
  value       = aws_security_group.db.id
}
```

### 2-D. `README.md` 갱신

`terraform/environments/staging/README.md` 첫 문단의 "아직 실행할 Terraform 자원과 배포 워크플로는 없으며" 를 지우고 아래를 덧붙인다.

```markdown
## 실행

- plan/apply: GitHub Actions `Infra staging` 을 develop 에서 dispatch (`apply=false` 로 plan 확인 → `apply=true`).
- 로컬은 `terraform init -backend=false && terraform validate` 까지만.
- ALB 허용 출처는 GitHub Environment `staging` 변수 `ALB_ALLOWED_IPV4_CIDRS` 로 넣는다(저장소에 커밋하지 않음).
- 앱 배포: `Deploy staging` 워크플로 → SSM → `/opt/app/deploy.sh` (`deploy/staging/`).
```

### 2-E. 로컬 검증 (AWS 호출 없음)

```bash
cd terraform/environments/staging
terraform fmt -recursive
terraform init -backend=false
# 러너(linux_amd64) 와 맥(darwin_arm64) 해시를 함께 고정 — CI 의 init -lockfile=readonly 가 통과하게
terraform providers lock -platform=linux_amd64 -platform=darwin_arm64
terraform validate
cd -
git add terraform/environments/staging   # .terraform.lock.hcl 포함, .terraform/ 는 gitignore 대상
```

`validate` 는 `alb_allowed_ipv4_cidrs` 값이 없어도 통과한다(값 검증은 plan 에서).

---

## Step 3. 인프라 워크플로 `.github/workflows/infra-staging.yml` — ✅ PR #62

- PR: AWS 인증 없이 fmt · validate 만 한다. infra 역할은 `develop` + environment `staging` 만 믿으므로 PR 에서는 plan 할 수 없다.
- develop 에서 dispatch: plan → (선택) 같은 plan 파일로 apply.
- 기존 `infra-ci.yml` · `infra-cd.yml`(prod) 은 손대지 않는다. `infra-v*` 태그는 prod 전용이다.

```yaml
name: Infra staging

# staging 전용 Terraform 루트(terraform/environments/staging) — prod 의 infra-ci · infra-cd · infra-v* 태그와 분리한다.
# - PR(→ develop): AWS 인증 없이 fmt · validate 만. infra 역할은 develop + environment staging 만 믿는다.
# - develop 에서 dispatch: plan → (apply=true 면) 같은 plan 파일로 apply.
on:
  pull_request:
    branches: [ develop ]
    paths:
      - 'terraform/environments/staging/**'
      - '.github/workflows/infra-staging.yml'
  workflow_dispatch:
    inputs:
      apply:
        description: 'true 면 plan 결과를 그대로 apply 한다 (먼저 false 로 plan 을 확인할 것)'
        type: boolean
        default: false

permissions:
  contents: read

env:
  TF_DIR: terraform/environments/staging

jobs:
  validate:
    name: fmt / validate (인증 없음)
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false
      - name: fmt
        run: terraform fmt -check -recursive -diff "$TF_DIR"
      - name: validate
        working-directory: ${{ env.TF_DIR }}
        run: |
          terraform init -input=false -backend=false -lockfile=readonly
          terraform validate

  plan-apply:
    name: plan / apply
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    environment: staging
    permissions:
      id-token: write
      contents: read
    # 앱 배포(deploy-staging.yml)와 같은 그룹 — staging 자원 변경은 한 번에 하나
    concurrency:
      group: api-staging-mutate
      cancel-in-progress: false
    env:
      TF_VAR_alb_allowed_ipv4_cidrs: ${{ vars.ALB_ALLOWED_IPV4_CIDRS }}
    steps:
      - uses: actions/checkout@v4

      - name: develop 브랜치 확인
        run: |
          if [ "$GITHUB_REF" != "refs/heads/develop" ]; then
            echo "::error::staging 인프라는 develop 에서만 적용한다 (현재 $GITHUB_REF)"; exit 1
          fi

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_INFRA_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false

      - name: init / validate
        working-directory: ${{ env.TF_DIR }}
        run: |
          terraform init -input=false -lockfile=readonly
          terraform validate

      - name: plan
        working-directory: ${{ env.TF_DIR }}
        run: |
          terraform plan -input=false -no-color -out=tfplan | tee plan.txt
          {
            echo "## staging terraform plan (${GITHUB_SHA::7})"
            echo '```'
            tail -c 60000 plan.txt
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"

      - name: apply
        if: ${{ inputs.apply }}
        working-directory: ${{ env.TF_DIR }}
        run: terraform apply -input=false tfplan

      - name: outputs
        if: ${{ inputs.apply }}
        working-directory: ${{ env.TF_DIR }}
        run: |
          {
            echo "## outputs"
            echo '```'
            terraform output
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"
```

```bash
actionlint .github/workflows/infra-staging.yml
```

---

## Step 4. 인프라 PR → 첫 apply — ✅ 완료 (2026-10-19)

> 실제 결과: PR #62 머지(`5eaae1f`) → plan run `39213109100` = **44 to add, 0 to change, 0 to destroy** (인증서 `dfe959e6`, EC2 `10.101.0.110` · t4g.medium · `ami-0171e38cc88437aa1`, 서브넷 240~243 확인) → apply run `39213499201` = **44 added**, 약 10분(RDS 대부분).
> apply 직후: EC2 running, SSM `Online`(agent 3.3.5390.0), user-data 완료(콘솔 출력에 `Docker Compose version v2.32.4`, cloud-init 07:05 UTC 종료), RDS available, DNS → ALB, **TG `unhealthy`(`Target.FailedHealthChecks`) — 앱이 아직 없어서 정상.**
>
> ```bash
> # user-data 완료 확인 (SSM 없이)
> aws ec2 get-console-output --instance-id i-0d487e887a65be933 --latest --output text | grep -E 'Docker Compose version|Cloud-init .* finished'
> ```

1. PR 을 만든다. Step 2 · 3 파일을 넣는다.
   ```bash
   git add terraform/environments/staging .github/workflows/infra-staging.yml
   git commit -m "feat(infra): staging API 인프라와 수동 적용 워크플로를 추가한다"
   git push -u origin feat/staging-infra
   gh pr create --base develop --title "feat(infra): staging API 인프라 (ALB · EC2 · RDS · Valkey)"
   ```
   PR 설명에 Step 0-C 조회 결과, 2-A 의 모듈 검토 결과, SG 규칙별 허용 이유를 붙인다.
2. PR 에서 `Infra staging / fmt / validate` 가 초록인지 확인한다. prod `Infra CI` 도 돌 수 있는데, 경로가 `terraform/**` 라서 그렇다. prod plan 에 **변경이 없어야 한다.**
3. 리뷰 후 머지한다.
4. **plan 만** 돌린다.
   ```bash
   gh workflow run infra-staging.yml --ref develop -f apply=false
   gh run watch "$(gh run list --workflow infra-staging.yml -L1 --json databaseId -q '.[0].databaseId')"
   ```
5. Summary 의 plan 을 확인한다.
   - **create 만 있어야 한다.** 기대 개수는 44 개다(첫 apply 기준). `destroy` · `replace` 가 하나라도 있으면 멈춘다.
   - 기존 VPC · edge 서브넷 · IGW · 기존 라우팅 테이블 · admin/gateway SG 가 변경 목록에 없어야 한다.
   - SG 규칙 출처가 의도한 IP 목록과 같은지 본다.
6. apply 한다.
   ```bash
   gh workflow run infra-staging.yml --ref develop -f apply=true
   ```
   RDS 생성에 10~15분이 걸린다.
7. Summary 의 outputs 에서 `instance_id` 를 GitHub 변수에 등록한다.
   ```bash
   gh variable set STAGING_INSTANCE_ID --env staging --body i-xxxxxxxxxxxxxxxxx
   ```
8. 확인한다(읽기 전용).
   ```bash
   aws ssm describe-instance-information \
     --filters Key=InstanceIds,Values=i-xxxxxxxxxxxxxxxxx \
     --query 'InstanceInformationList[0].PingStatus' --output text   # Online
   aws elbv2 describe-target-health --target-group-arn <target_group_arn> \
     --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text
   # 이 시점엔 unhealthy 가 정상 — 아직 컨테이너가 없다
   ```

---

## Step 5. 서버 배포 스크립트 (`deploy/staging/`) — ✅ PR #65

저장소에 두고 배포할 때마다 SSM 으로 서버에 덮어쓴다. 스크립트를 바꿔도 서버 교체가 필요 없고, 변경 이력이 git 에 남는다.

#### `deploy/staging/docker-compose.yml`

```yaml
# staging API 전용 — 로컬 개발용 루트 compose.yaml(postgres · valkey) 은 배포하지 않는다.
# 변수(ECR_IMAGE · IMAGE_TAG · AWS_REGION · LOG_GROUP · INSTANCE_ID)는 deploy.sh 가 셸 환경으로 넘긴다.
services:
  api:
    image: ${ECR_IMAGE:?}:${IMAGE_TAG:?}
    container_name: api
    restart: unless-stopped
    # Spring graceful shutdown(20s) 이 끝날 시간을 준다
    stop_grace_period: 30s
    ports:
      - "8080:8080" # API — ALB SG 에서만 접근
      - "9090:9090" # actuator readiness — ALB 헬스체크 · deploy.sh 확인용
    env_file:
      - app.env
    deploy:
      resources:
        limits:
          memory: 3072M # t4g.medium(4GiB) 기준. 인스턴스 타입을 바꾸면 함께 조정
    logging:
      driver: awslogs
      options:
        awslogs-region: ${AWS_REGION:?}
        awslogs-group: ${LOG_GROUP:?}
        awslogs-stream: ${INSTANCE_ID:?}
```

#### `deploy/staging/deploy.sh`

```bash
#!/bin/bash
# staging API 컨테이너 교체. GitHub Actions(Deploy staging) 가 SSM Run Command 로 root 권한 실행한다.
# 사용: deploy.sh sha-<40자리 커밋 SHA>
# 복구 연습: DRILL_FORCE_FAIL=1 deploy.sh <tag> → 새 이미지 확인을 일부러 실패시켜 직전 이미지 복구 경로를 탄다.
set -euo pipefail

TAG="${1:-}"
if [[ ! "$TAG" =~ ^sha-[0-9a-f]{40}$ ]]; then
  echo "ERROR: 이미지 태그 형식이 아니다: '$TAG' (sha-<40자리 SHA>)"
  exit 2
fi

REGION=ap-northeast-2
REPO_NAME=habilis-api-staging-api
SECRET_ID=habilis-api/staging/infra
APP_DIR=/opt/app
READY_URL=http://127.0.0.1:9090/actuator/health/readiness
READY_TRIES=60 # 5초 간격 → 최대 5분 (첫 기동은 Flyway 마이그레이션 포함)

# 동시 실행 방지 — Actions 가 끝나도 SSM 명령은 계속 돌 수 있다
exec 9>/var/lock/habilis-api-deploy.lock
if ! flock -n 9; then
  echo "ERROR: 다른 배포가 실행 중이다"
  exit 3
fi

cd "$APP_DIR"

ACCOUNT_ID=$(aws sts get-caller-identity --region "$REGION" --query Account --output text)
REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
IMDS_TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
INSTANCE_ID=$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id)
export ECR_IMAGE="$REGISTRY/$REPO_NAME" AWS_REGION="$REGION" \
  LOG_GROUP=/habilis-api/staging/app INSTANCE_ID

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

# 앱 환경변수 — 시크릿 JSON 을 KEY=VALUE 로. umask 077 → 0600. 개행이 든 값은 거부한다.
umask 077
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
    --query SecretString --output text \
  | jq -er 'to_entries[]
      | if (.value | tostring | test("\n")) then error("개행이 든 값: \(.key)")
        else "\(.key)=\(.value)" end' > app.env.new
mv app.env.new app.env

PREV_TAG=$(cat current-tag 2>/dev/null || true)

start() {
  IMAGE_TAG="$1" docker compose up -d --no-deps api
}

wait_ready() {
  for _ in $(seq 1 "$READY_TRIES"); do
    if curl -fsS -o /dev/null "$READY_URL"; then
      return 0
    fi
    sleep 5
  done
  return 1
}

echo "pull: $ECR_IMAGE:$TAG"
docker pull "$ECR_IMAGE:$TAG"

echo "교체: ${PREV_TAG:-없음} -> $TAG (서버 1대 — 교체 중 잠깐 중단된다)"
start "$TAG"

if [ "${DRILL_FORCE_FAIL:-}" != "1" ] && wait_ready; then
  echo "$TAG" > current-tag
  echo "RUNNING=$(docker inspect api --format '{{.Config.Image}}')"
  echo "OK: $TAG ready"
  exit 0
fi

echo "ERROR: $TAG 가 준비되지 않았다. 최근 로그:"
docker logs --tail 100 api 2>&1 || true

if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$TAG" ]; then
  echo "직전 이미지 $PREV_TAG 로 복구한다"
  start "$PREV_TAG"
  if wait_ready; then
    echo "RUNNING=$(docker inspect api --format '{{.Config.Image}}')"
    echo "복구 완료: $PREV_TAG (DB 마이그레이션은 되돌려지지 않는다)"
  else
    echo "ERROR: 복구도 실패했다 — SSM 으로 접속해 docker logs api 를 확인한다"
  fi
fi
exit 1
```

```bash
chmod +x deploy/staging/deploy.sh
bash -n deploy/staging/deploy.sh && shellcheck deploy/staging/deploy.sh
```

**동작 요약**

| 상황 | 결과 |
|---|---|
| 태그 형식 오류 | exit 2, 아무것도 바꾸지 않음 |
| 다른 배포 실행 중 | exit 3 |
| 새 이미지 readiness 성공 | `current-tag` 갱신, `RUNNING=<image>` 출력, exit 0 |
| 새 이미지 실패 + 직전 이미지 있음 | 직전 이미지로 재기동 · 확인, exit 1 (워크플로 실패) |
| 첫 배포 실패(직전 이미지 없음) | 로그만 출력, exit 1 |

**DB 마이그레이션 주의**: Flyway 는 앱 기동 때 돈다. 새 이미지가 마이그레이션을 적용한 뒤 실패하면, 복구된 직전 이미지는 **새 스키마** 위에서 돈다. 그래서 마이그레이션은 항상 expand-contract 로 쓴다(이전 앱에서도 동작하게).

---

## Step 6. 앱 배포 워크플로 `.github/workflows/deploy-staging.yml` — ✅ PR #65

- `develop` push 마다 staging 에 자동 배포한다. 문서 · terraform 만 바꾼 push 는 건너뛴다.
- 수동 dispatch 에 `rollback_tag` 를 주면 빌드 없이 그 이미지로 되돌린다.
- 일반 GitHub 러너는 ALB 허용 출처가 아니다. 그래서 HTTPS 외부 검사는 하지 않고, 서버 내부 readiness(deploy.sh)로 판정한다. **ALB 를 전체 인터넷에 열지 않는다.**
- 기존 prod `CD` 는 그대로 둔다.
- `태그 결정` 단계의 mode: `build`(push · dispatch 빈 rollback_tag) · `rollback`(rollback_tag 지정) · `skip`(**push 인데 `STAGING_INSTANCE_ID` 가 비었을 때** — 인프라 전 머지 대비. dispatch 에서는 오류).

```yaml
name: Deploy staging

# develop push 마다 staging(api-staging.habilis-console.com)에 자동 배포한다. prod CD(cd.yml)와 분리.
# - 수동 dispatch 에 rollback_tag 를 주면 빌드 없이 그 이미지로 되돌린다.
# - 일반 GitHub 러너는 ALB 허용 출처가 아니므로 외부 HTTPS 검사는 하지 않고 서버 내부 readiness(deploy.sh)로 판정한다.
#   검사를 통과시키려고 ALB 를 전체 인터넷에 열지 않는다.
on:
  push:
    branches: [ develop ]
    paths-ignore:
      - 'terraform/**'
      - 'docs/**'
      - 'http/**'
      - '**/*.md'
      - '.github/workflows/infra-*.yml'
  workflow_dispatch:
    inputs:
      rollback_tag:
        description: '비우면 현재 커밋을 빌드해 배포한다. 값(sha-<40자리>)을 주면 빌드 없이 그 이미지로 되돌린다'
        required: false
        type: string

permissions:
  contents: read

# staging 자원을 바꾸는 작업은 한 번에 하나 (infra-staging.yml 과 같은 그룹)
concurrency:
  group: api-staging-mutate
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    timeout-minutes: 45
    permissions:
      id-token: write
      contents: read
    env:
      AWS_REGION: ${{ vars.AWS_REGION }}
      ECR_REPOSITORY: ${{ vars.ECR_REPOSITORY }}
      INSTANCE_ID: ${{ vars.STAGING_INSTANCE_ID }}
    steps:
      - uses: actions/checkout@v4

      # mode: build(현재 커밋) · rollback(기존 이미지) · skip(서버가 아직 없음 — push 에서만)
      - name: 태그 결정
        id: tag
        env:
          ROLLBACK_TAG: ${{ inputs.rollback_tag }}
        run: |
          if [ "$GITHUB_REF" != "refs/heads/develop" ]; then
            echo "::error::staging 배포는 develop 에서만 한다 (현재 $GITHUB_REF)"; exit 1
          fi
          # 인프라 apply 전(STAGING_INSTANCE_ID 미등록)의 develop push 는 실패 대신 건너뛴다
          if [ -z "$INSTANCE_ID" ]; then
            if [ "$GITHUB_EVENT_NAME" = "push" ]; then
              echo "::notice::STAGING_INSTANCE_ID 가 없어 배포를 건너뛴다 (Infra staging apply 후 등록)"
              echo "mode=skip" >> "$GITHUB_OUTPUT"
              exit 0
            fi
            echo "::error::GitHub Environment staging 변수 STAGING_INSTANCE_ID 가 없다"; exit 1
          fi
          if [ -n "$ROLLBACK_TAG" ]; then
            TAG="$ROLLBACK_TAG"; MODE=rollback
          else
            TAG="sha-${GITHUB_SHA}"; MODE=build
          fi
          if [[ ! "$TAG" =~ ^sha-[0-9a-f]{40}$ ]]; then
            echo "::error::태그 형식 오류: $TAG"; exit 1
          fi
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "mode=$MODE" >> "$GITHUB_OUTPUT"

      - uses: aws-actions/configure-aws-credentials@v4
        if: steps.tag.outputs.mode != 'skip'
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}

      # ---------------- build 모드 ----------------
      - name: JDK 24 (Corretto)
        if: steps.tag.outputs.mode == 'build'
        uses: actions/setup-java@v4
        with:
          distribution: corretto
          java-version: '24'

      - name: Gradle
        if: steps.tag.outputs.mode == 'build'
        uses: gradle/actions/setup-gradle@v4

      - name: Test
        if: steps.tag.outputs.mode == 'build'
        run: ./gradlew test

      - name: Jib arm64 이미지 → ECR
        if: steps.tag.outputs.mode == 'build'
        env:
          TAG: ${{ steps.tag.outputs.tag }}
        run: |
          REGISTRY="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.${AWS_REGION}.amazonaws.com"
          ECR_PASSWORD=$(aws ecr get-login-password)
          echo "::add-mask::$ECR_PASSWORD"
          # -Pversion → jib jvmFlags 의 -Drelease → Sentry release = 이미지 태그 (prod CD 와 같은 방식)
          ./gradlew jib --console=plain \
            -Pversion="$TAG" \
            -Djib.to.image="$REGISTRY/$ECR_REPOSITORY:$TAG" \
            -Djib.to.auth.username=AWS \
            -Djib.to.auth.password="$ECR_PASSWORD" \
            -x test -x ktlintCheck -x ktlintFormat

      # ---------------- rollback 모드 ----------------
      - name: 롤백 이미지 존재 확인
        if: steps.tag.outputs.mode == 'rollback'
        env:
          TAG: ${{ steps.tag.outputs.tag }}
        run: |
          aws ecr describe-images --repository-name "$ECR_REPOSITORY" --image-ids imageTag="$TAG" >/dev/null \
            || { echo "::error::ECR 에 $TAG 가 없다"; exit 1; }

      # ---------------- 배포 ----------------
      - name: SSM Run Command 로 컨테이너 교체
        id: ssm
        if: steps.tag.outputs.mode != 'skip'
        env:
          TAG: ${{ steps.tag.outputs.tag }}
        run: |
          # deploy.sh · compose 는 저장소가 원본 — 배포마다 서버에 덮어써서 서버 교체 없이 바꾼다
          DEPLOY_B64=$(base64 -w0 deploy/staging/deploy.sh)
          COMPOSE_B64=$(base64 -w0 deploy/staging/docker-compose.yml)
          PARAMS=$(jq -n --arg d "$DEPLOY_B64" --arg c "$COMPOSE_B64" --arg t "$TAG" '{
            commands: [
              "set -eu",
              "install -d -m 750 /opt/app",
              "echo \($d) | base64 -d > /opt/app/deploy.sh",
              "chmod 750 /opt/app/deploy.sh",
              "echo \($c) | base64 -d > /opt/app/docker-compose.yml",
              "/opt/app/deploy.sh \($t)"
            ],
            executionTimeout: ["900"]
          }')

          CMD_ID=$(aws ssm send-command \
            --instance-ids "$INSTANCE_ID" \
            --document-name AWS-RunShellScript \
            --comment "staging $TAG run ${GITHUB_RUN_ID}" \
            --timeout-seconds 120 \
            --parameters "$PARAMS" \
            --query Command.CommandId --output text)
          echo "command_id=$CMD_ID" >> "$GITHUB_OUTPUT"
          echo "SSM command: $CMD_ID"

          STATUS=Pending
          for _ in $(seq 1 100); do   # 10초 × 100 = 약 16분 (executionTimeout 900s 보다 길게)
            sleep 10
            STATUS=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
              --query Status --output text 2>/dev/null || echo Pending)
            echo "status: $STATUS"
            case "$STATUS" in Success|Failed|Cancelled|TimedOut) break ;; esac
          done

          OUT=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
            --query StandardOutputContent --output text)
          echo "$OUT"
          echo "--- stderr ---"
          aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
            --query StandardErrorContent --output text

          if [ "$STATUS" != "Success" ]; then
            echo "::error title=staging 배포 실패::SSM 상태=$STATUS (deploy.sh 가 직전 이미지 복구를 시도했다 — 위 출력 확인)"
            exit 1
          fi
          # 기록만 바뀐 것으로 완료 처리하지 않는다 — 실제 실행 중인 이미지를 대조한다
          echo "$OUT" | grep -q "^RUNNING=.*:${TAG}$" \
            || { echo "::error::실행 중인 이미지가 $TAG 가 아니다"; exit 1; }

      - name: 배포 기록
        if: steps.tag.outputs.mode != 'skip'
        env:
          TAG: ${{ steps.tag.outputs.tag }}
          CMD_ID: ${{ steps.ssm.outputs.command_id }}
          MODE: ${{ steps.tag.outputs.mode }}
          API_BASE_URL: ${{ vars.API_BASE_URL }}
        run: |
          PREV=$(aws ssm get-parameter --name /habilis-api/staging/image-tag --query Parameter.Value --output text)
          aws ssm put-parameter --name /habilis-api/staging/image-tag --value "$TAG" --type String --overwrite
          {
            echo "## staging 배포 ($MODE)"
            echo "| 항목 | 값 |"
            echo "|---|---|"
            echo "| 이미지 | \`$TAG\` |"
            echo "| 이전 | \`$PREV\` |"
            echo "| 커밋 | \`$GITHUB_SHA\` |"
            echo "| SSM command | \`$CMD_ID\` |"
            echo "| API | $API_BASE_URL (사내망 · VPN 에서 확인) |"
          } >> "$GITHUB_STEP_SUMMARY"
```

```bash
actionlint .github/workflows/deploy-staging.yml
```

**롤백 명령**

```bash
# 되돌릴 수 있는 태그 (최신순)
aws ecr describe-images --repository-name habilis-api-staging-api \
  --query 'reverse(sort_by(imageDetails,&imagePushedAt))[].imageTags[0]' --output text | tr '\t' '\n' | head
gh workflow run deploy-staging.yml --ref develop -f rollback_tag=sha-<40자리>
```

---

## Step 7. 첫 배포와 검증

### 7-A. 첫 배포 — ✅ 완료 (2026-10-19)

배포 PR(Step 5 · 6 파일)을 머지하면 `Deploy staging` 이 자동으로 돈다. 첫 기동은 Flyway 가 빈 DB 에 전체 DDL 을 적용하므로 수 분 걸린다.

> 실제 결과: PR #65 머지 08:27 UTC → run `39222918691` 성공(약 4분). 단계: 태그 결정(`build`) → Test → Jib arm64 → ECR → SSM 교체(`RUNNING=…:sha-2172963fc114c2ff55f7e72c135a79791c335e06`) → 배포 기록. `롤백 이미지 존재 확인` 은 build 모드라 skipped. 직후 TG `healthy`, `/habilis-api/staging/image-tag` = 새 태그. 앱 로그 ERROR 없음(WARN 은 10-B ⑱ — 모두 예상).
>
> ```bash
> gh run view <run-id> --json conclusion,jobs --jq '.conclusion, (.jobs[].steps[] | "\(.conclusion)\t\(.name)")'
> gh run view <run-id> --log | grep 'RUNNING='
> ```

```bash
gh run watch "$(gh run list --workflow deploy-staging.yml -L1 --json databaseId -q '.[0].databaseId')"
```

### 7-B. 정상 동작 확인

| 확인 | 명령 / 방법 | 기대 |
|---|---|---|
| 대상 그룹 | `aws elbv2 describe-target-health --target-group-arn <tg> --query 'TargetHealthDescriptions[0].TargetHealth.State'` | `healthy` |
| HTTPS · 인증서 (VPN 켬) | `curl -sSI https://api-staging.habilis-console.com/health` | `HTTP/2 200`, 인증서 오류 없음 |
| HTTP → HTTPS | `curl -sSI http://api-staging.habilis-console.com/health` | `301` + `Location: https://...` |
| 기록 | `aws ssm get-parameter --name /habilis-api/staging/image-tag --query Parameter.Value` | 방금 배포한 `sha-...` |
| 로그 | `aws logs tail /habilis-api/staging/app --since 10m` | ECS JSON, ERROR 없음. **staging 은 `logging.level.root: warn`**(`application-logging.yaml`) 이라 `Started …` · Flyway `Successfully applied` 같은 INFO 는 **안 보인다** — 기동 판정은 TG healthy · `RUNNING=` 로 한다 |
| 프로필 | 시크릿 `SPRING_PROFILES_ACTIVE=staging` · 로그에 staging 전용 경고(Swagger 활성 등) | prod · local 이 섞이지 않음 (INFO 의 `profiles are active` 줄은 위 이유로 안 보임) |
| DB 쓰기 | 테스트 계정 가입 → 로그인 | 200 · 토큰 발급 |
| Valkey (rate limit) | 같은 이메일로 `POST /api/v1/auth/password/forgot` 4회 | 1~3회 `204`, 4회째 `429` |
| Valkey 장애 감지 | 4회째도 `204` 면 로그에서 `[rate-limit] Valkey 장애로 제한을 건너뜁니다 (fail-open)` 검색 | 이 로그가 없어야 정상 |
| CORS 허용 | `curl -si -X OPTIONS https://api-staging.habilis-console.com/api/v1/auth/login -H 'Origin: https://staging.habilis-console.com' -H 'Access-Control-Request-Method: POST'` | `Access-Control-Allow-Origin: https://staging.habilis-console.com` |
| CORS 거부 | 같은 명령에 `Origin: https://evil.example` | `Access-Control-Allow-Origin` 없음(403) |
| Swagger | VPN 에서 `/swagger-ui.html` | 열림(`SWAGGER_ALLOWED_IPS`) — ✅ 2026-10-19 확인 |
| OpenAPI 서버 주소 | `curl -s https://api-staging.habilis-console.com/v3/api-docs \| head -c 300` | `servers` 가 `https://api-staging…` (http 면 Swagger 의 Try it out 이 mixed content 로 실패) |

rate limit 확인 명령:

```bash
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api-staging.habilis-console.com/api/v1/auth/password/forgot \
    -H 'Content-Type: application/json' -d '{"email":"ratelimit-test@example.com"}'
done
```

서버 내부 확인 (SSM 세션 권한이 있을 때):

```bash
aws ssm start-session --target <instance_id> --profile namhee
sudo docker ps                         # api  Up (healthy 표시는 없음 — compose healthcheck 미정의)
curl -s localhost:9090/actuator/health/readiness   # {"status":"UP"}
sudo cat /opt/app/current-tag
sudo ls -l /opt/app/app.env            # -rw------- root
```

### 7-C. 차단 확인 (VPN 끈 외부망 · 휴대폰 테더링)

```bash
curl -sS --max-time 5 https://api-staging.habilis-console.com/health   # 타임아웃이어야 한다
PUB=<instance_public_ip>
for p in 22 8080 9090 5432 6379; do nc -vz -w 3 $PUB $p; done          # 전부 실패해야 한다
```

- 타임아웃만 보고 SG 차단이라고 단정하지 않는다. 같은 8080 · 9090 이 **서버 내부에서는 응답하고 ALB 경유로는 성공**하는 것과 함께 비교해 판정한다.
- DB · 캐시 SG 인바운드 출처가 서버 SG 하나뿐인지 확인한다.
  ```bash
  aws ec2 describe-security-group-rules --filters Name=group-id,Values=<db-sg>,<cache-sg> \
    --query 'SecurityGroupRules[?!IsEgress].[GroupId,FromPort,ReferencedGroupInfo.GroupId,CidrIpv4]' --output table
  ```
- 서버 SG 가 없는 경로가 막히는지는 VPC Reachability Analyzer 로 확인한다.

### 7-D. DB TLS 확인

SSM 세션에서 실행한다. 비밀번호는 서버의 `app.env` 에서 읽는다(사람이 실행).

```bash
sudo dnf install -y postgresql16
set -a; sudo cat /opt/app/app.env | grep -E '^DB_' > /tmp/db.env; . /tmp/db.env; rm /tmp/db.env; set +a
PGPASSWORD=$DB_PASSWORD psql "host=$DB_HOST user=$DB_USER dbname=postgres sslmode=require" \
  -c "select ssl, version from pg_stat_ssl where pid = pg_backend_pid();"
# ssl = t
```

---

## Step 8. 복구 연습

### 8-A. 자동 복구 (새 이미지 실패 → 직전 이미지)

두 번 이상 배포해 `current-tag` 가 있는 상태에서 실행한다. 서버 세션에서 이전 태그로 강제 실패를 건다.

```bash
sudo DRILL_FORCE_FAIL=1 /opt/app/deploy.sh sha-<직전 배포 태그>
# 기대: "ERROR: ... 준비되지 않았다" → "직전 이미지 ... 로 복구한다" → "복구 완료" → exit 1
sudo cat /opt/app/current-tag     # 원래 태그 그대로
```

### 8-B. 수동 롤백 (워크플로)

```bash
gh workflow run deploy-staging.yml --ref develop -f rollback_tag=sha-<이전 태그>
# 확인 후 최신으로 복귀
gh workflow run deploy-staging.yml --ref develop -f rollback_tag=sha-<최신 태그>
```

### 8-C. 재부팅 후 자동 기동 · 데이터 유지

```bash
aws ssm send-command --instance-ids <instance_id> --document-name AWS-RunShellScript \
  --parameters 'commands=["sudo reboot"]' --profile namhee
# 2~3분 뒤: 대상 그룹 healthy, 7-B 의 테스트 계정으로 다시 로그인 성공
```

### 8-D. RDS 특정 시점 복구(PITR) → 별도 DB 로 확인

```bash
aws rds restore-db-instance-to-point-in-time --profile namhee \
  --source-db-instance-identifier habilis-api-staging-db \
  --target-db-instance-identifier habilis-api-staging-db-restore-test \
  --use-latest-restorable-time \
  --db-subnet-group-name habilis-api-staging-db-subnet \
  --vpc-security-group-ids <db_security_group_id> \
  --no-publicly-accessible --no-multi-az
aws rds wait db-instance-available --db-instance-identifier habilis-api-staging-db-restore-test
# SSM 세션에서 7-D 처럼 접속해 테스트 계정 행이 있는지 확인 (호스트만 복원 DB 엔드포인트로)
```

> **삭제 주의** — 확인이 끝나면 복원한 **테스트 DB 만** 지운다. 식별자가 `-restore-test` 인지 두 번 확인한다. 원본 `habilis-api-staging-db` 는 삭제 보호가 걸려 있다.
> ```bash
> aws rds delete-db-instance --db-instance-identifier habilis-api-staging-db-restore-test \
>   --skip-final-snapshot --profile namhee
> ```

개인 계정 권한이 없는 명령(reboot · restore · delete)은 관리자에게 요청한다.

### 8-E. 기록

결과를 복구 기록에 남긴다: 실행 시각, 명령, 걸린 시간(RTO), 복원 시점과 데이터 손실 범위(RPO).

---

## Step 9. 프런트엔드 연동 (habilis_console_web)

API 쪽 CI/CD 와 별개인 저장소 작업이다. 확인 항목만 정리한다.

1. 프런트 GitHub Environment `staging` 에 `VITE_API_BASE_URL=https://api-staging.habilis-console.com` 을 등록한다. `pnpm build` 단계의 env 로 넘긴다. 빌드 때 JS 에 박히므로, 값을 바꾸면 재빌드 · 재배포한다.
2. API 클라이언트가 `import.meta.env.VITE_API_BASE_URL` 을 읽게 한다. 요청 · 응답은 staging Swagger(OpenAPI)와 대조한다.
3. 인증 헤더는 `x-access-token` 이다. 토큰 갱신 방식을 서버 `AuthController` 와 맞춘다.
4. 메일 링크 경로(`/verify-email` · `/reset-password`)가 프런트 라우트와 같은지 확인한다. staging 은 `AUTH_EMAIL_PROVIDER=log` 라 메일이 실제로 나가지 않는다. 링크는 CloudWatch 로그에서 확인한다.
5. 브라우저 DevTools 에서 확인한다.
   - 로그인 요청이 `api-staging` 으로 가는지
   - 가입 · 로그인 · 만료 · 로그아웃 · 권한 없는 요청 · 새로고침이 정상인지

---

## 10. 장애 대응 — 어디를 볼까

| 증상 | 먼저 볼 곳 | 흔한 원인 |
|---|---|---|
| `AssumeRoleWithWebIdentity` 거부 | 워크플로 `environment: staging` · 실행 ref · 역할 ARN | develop 이 아닌 브랜치에서 실행, environment 이름 오타, 역할 신뢰 조건 |
| plan 에서 `aws_acm_certificate` 조회 실패 | Step 1 | 인증서가 아직 `PENDING_VALIDATION` |
| plan 에서 `alb_allowed_ipv4_cidrs` 검증 실패 | GitHub 변수 `ALB_ALLOWED_IPV4_CIDRS` | 비어 있음, 따옴표 · 대괄호 형식 오류, `/24` 보다 넓음 |
| SSM `send-command` 가 `InvalidInstanceId` | `describe-instance-information` | SSM agent 오프라인, 인스턴스 프로필 권한 부족 |
| deploy.sh `docker pull` 실패 | SSM 출력 | EC2 역할 ECR 권한, 태그 오타 |
| deploy.sh readiness 실패 | `aws logs tail /habilis-api/staging/app` | 필수 환경변수 누락(앱이 DB 연결 전 중단), Flyway 실패, RDS SG |
| 컨테이너가 바로 종료 | 로그의 첫 ERROR | `SPRING_PROFILES_ACTIVE` 오류, 시크릿 키 이름 오타 |
| TG unhealthy · 서버 내부는 정상 | SG `server_health` · `alb_to_health` 규칙 | 9090 경로 차단 |
| 브라우저 CORS 오류 | 시크릿 `CORS_ALLOWED_ORIGIN_PATTERNS` | 프런트 origin 불일치(끝 `/` 포함 여부) |
| 4회째도 204 | 로그 `[rate-limit]` | Valkey 연결 실패(cache SG · 엔드포인트) |
| 외부망에서 접속됨 | ALB SG 인바운드 | 허용 목록에 넓은 대역 · 개인 IP |

로그 검색:

```bash
aws logs tail /habilis-api/staging/app --since 30m --filter-pattern '"ERROR"'
aws ssm list-command-invocations --instance-id <instance_id> --details --max-items 3 \
  --query 'CommandInvocations[].[CommandId,Status,RequestedDateTime]' --output table
```

---

### 10-B. 실제로 겪은 문제와 해결 (2026-10-16 ~ 10-19)

번호는 다른 절에서 참조한다.

**AWS 계정 · 권한**

| # | 증상 | 원인 | 해결 |
|---|---|---|---|
| ① | `aws` 명령이 만료 오류, 또는 `aws login` 이 region 을 묻는다 | 로그인 세션 만료. `--profile` 없이 `aws login` 하면 default 프로필 설정 프롬프트가 뜬다 | `aws login --profile namhee` 처럼 프로필을 명시한다. 프롬프트에 다른 명령을 붙여넣지 않는다. 명령은 한 줄씩 실행한다 |
| ② | `aws iam simulate-principal-policy` 가 Route 53 · ACM 을 `implicitDeny` 로 보고 | 정책 조건(태그 · 레코드 이름)을 `--context-entries` 로 주지 않으면 조건부 Allow 가 안 맞는다 | 시뮬레이션은 참고만. 정책 원문(그룹 `habilis-api-staging-operators` · 역할 정책)을 읽어 판정한다 |
| ③ | ACM 콘솔에 `acm-pca:ListCertificateAuthorities` 권한 오류 | 사설 CA 목록 조회 — 퍼블릭 인증서와 무관 | 무시하고 진행 |
| ④ | `acm:RequestCertificate` AccessDenied | 개인 계정에 발급 권한 없음 | 관리자가 `RequestApiStagingCertificate` · `TagApiStagingCertificate` · `ReadStagingCertificates` 문을 추가. 요청 시 태그 2개 필수 |
| ⑤ | 인증서 `VALIDATION_TIMED_OUT` | 검증 CNAME 을 72시간 안에 안 넣음 | 재발급 → CNAME 등록(이름 · 값은 같은 도메인이면 동일) → 옛 인증서 삭제 |
| ⑥ | (예방) OIDC `AssumeRoleWithWebIdentity` 거부 예상 | 역할 trust 의 `ref` 가 `refs/heads/main` | 관리자에게 `refs/heads/develop` 수정 요청 — 완료. staging 브랜치를 바꾸면 trust 도 같이 바꾼다 |
| ⑦ | `GetSecretValue` AccessDenied (namhee · readonly) | 의도된 제한. readonly 는 값 읽기 없음, namhee 는 prod 시크릿만 별도 inline 허용 | 값은 사람이 필요할 때만 본다. 에이전트는 키 이름만 다룬다 |

**Terraform · infra 역할 권한** — infra 역할은 "태그 `Project=habilis-api` · `Environment=staging` + 이름 `habilis-api-staging-*`" 조건으로만 생성을 허용한다. 생성 시점에 태그를 못 붙이는 리소스 형태는 거부된다.

| # | 증상 | 원인 | 해결 |
|---|---|---|---|
| ⑧ | (simulate) SG 규칙 생성 거부 | `aws_vpc_security_group_ingress/egress_rule` 은 규칙 자체에 `default_tags` 를 붙인다 → `security-group-rule` 태그 생성 권한 없음 | `aws_security_group_rule` 로 작성(태그 없음) |
| ⑨ | (simulate) ENI 태그 추가 거부 | `aws_ec2_tag` 는 생성 후 태그 추가 — 이미 Project/Environment 태그가 있는 자원만 허용 | ENI 태그 블록 제거 |
| ⑩ | (정책 검토) 시크릿 읽기 · 삭제, RDS 생성 거부 예상 | `secretsmanager:GetResourcePolicy` · `DeleteSecret` 누락, `rds:CreateDBInstance` 리소스에 `og:default:postgres-16` 누락 | 관리자 추가 — 완료. 첫 plan/apply 무오류 |
| ⑳ | 파일 이름 `secrets.tf` 쓰기 차단 | 저장소 쓰기 가드가 `*secret*` 경로를 보호 | `app_env.tf` 로 이름 변경. 가드를 우회하지 않는다 |

**GitHub · CI · 배포**

| # | 증상 | 원인 | 해결 |
|---|---|---|---|
| ⑪ | 배포 PR #63 을 인프라 · 변수 준비 전에 머지 | — | push run 은 `STAGING_INSTANCE_ID` 가 비어 `skip` 모드로 초록 종료(자원 변경 없음). 그래도 PR #64 로 되돌리고, 준비 후 **되돌림을 되돌리는** PR #65 로 재추가. 되돌림 PR 머지 = 되돌림 실행이다 |
| ⑫ | `staging` 환경이 브랜치 제한 없이 생김 | 워크플로가 없는 environment 를 참조하면 GitHub 가 자동 생성 | Settings → Environments → staging → Deployment branches 를 `develop` 만으로 설정(0-F 의 `gh api` 로 확인) |
| ⑬ | 사무실에서 `checkip` 결과가 매번 다름 · 간헐 타임아웃 | 멀티 WAN — 출구 IP 여러 개 | 관찰한 6개를 임시 등록. 공식 목록은 네트워크 담당자 → 13장 |
| ⑭ | 새 브랜치에서 `handoff.md` 충돌 · 이미 머지된 변경이 다시 보임 | 머지 후 `git fetch` 없이 오래된 `origin/develop` 에서 분기 | 분기 전 항상 `git fetch && git switch -c <br> origin/develop` |
| ⑮ | develop PR 이 머지 불가(필수 체크 `build` 대기) | CI 의 `paths-ignore` 로 job 자체가 안 돌아 필수 체크가 보고되지 않음 | PR #59: CI 는 항상 돌고, 「변경 범위 확인」 단계가 terraform/docs/http/scripts/`infra-*` 워크플로/`*.md` 만 바뀐 경우 빌드를 건너뛴다(약 7초) |
| ⑯ | apply 직후 TG `unhealthy`(`Target.FailedHealthChecks`) | 컨테이너가 아직 없음 | 정상. 첫 배포 후 `healthy` |
| ⑰ | 룰셋 bypass 가 `always` | 관리자 bypass 가 PR 없이 직접 push 도 허용 | `For pull requests only` 로 변경 권장(사용자 설정) |
| ⑲ | ALB 허용 IP 를 바꿨는데 Swagger 가 403 | `SWAGGER_ALLOWED_IPS` 는 시크릿 → 앱 **기동 시** 읽음 | apply 후 앱 재배포까지 해야 반영 → 13장 |

**앱 기동 로그 (첫 배포의 WARN — 모두 예상된 것)**

| # | 로그 | 의미 |
|---|---|---|
| ⑱-a | Flyway `outOfOrder mode is active` | 설정상 늘 나오는 경고. 이후 정상 기동 = 마이그레이션 완료 |
| ⑱-b | `기능 구성 서명 키가 없습니다 — 서명 없이 내려보냅니다` | staging 시크릿에 서명 키 없음. 런처 서명 검증을 시험하려면 키를 추가한다 |
| ⑱-c | `콘솔 버전을 찾을 수 없습니다` | 기동 직후 warmup 이 빈 DB 를 조회. 데이터 넣으면 사라진다 |
| ⑱-d | SpringDoc `/v3/api-docs` · `/swagger-ui.html` enabled | 의도적으로 켬(IP 제한) |
| ⑱-e | `sun.misc.Unsafe::allocateMemory` (netty) | JDK 24 경고. 동작 영향 없음 |
| — | INFO 로그(`Started …`)가 없음 | staging `root: warn`. 필요하면 일시적으로 레벨을 올리지 말고 TG · readiness 로 판정 |

**로컬 셸**

| # | 증상 | 해결 |
|---|---|---|
| ㉑ | zsh 에서 `for i in $A` 가 한 덩어리로 돈다 | zsh 는 변수 단어 분리를 안 한다 → `bash -c '…'` 로 실행 |
| ㉒ | heredoc 이 끝나지 않는다 | 닫는 `EOF` 앞에 공백이 있으면 인식 안 됨 → 줄 맨 앞에 쓰거나 한 줄 명령으로 |

---

## 11. PR 나누기와 완료 산출물

| PR | 내용 | 검증 |
|---|---|---|
| ① 인프라 — ✅ #62 | `terraform/environments/staging/**`, `infra-staging.yml`, staging README | fmt · validate, develop dispatch plan(create 만), apply |
| ② 배포 — ✅ #65 (#63 → #64 되돌림 → #65) | `deploy/staging/**`, `deploy-staging.yml` | actionlint · shellcheck, 머지 후 자동 배포 성공 |
| ③ 프런트 | habilis_console_web API client · env | staging 브라우저 연동 |

**완료 기준 (온보딩 12장)**

- [ ] 인프라 PR · 배포 PR · 프런트 PR 링크 — 인프라 #62 · 배포 #65 완료, 프런트 대기
- [x] `Infra staging` apply 성공 실행 URL, `Deploy staging` 성공 실행 URL — `actions/runs/39213499201` · `actions/runs/39222918691`
- [ ] 7-B 정상 확인 표 결과 (`/health` 만으로 완료 처리하지 않음)
- [ ] 7-C 차단 확인 결과 (출발지 · 목적지 · 결과)
- [ ] 8-A ~ 8-D 복구 연습 기록 (RTO · RPO)
- [ ] SG 규칙별 허용 이유, SG 와 NACL 차이, stateful 의미, CORS 로 서버 접근을 막을 수 없는 이유 정리

---

## 12. 후속 개선 (이번 범위 밖)

| 항목 | 내용 | 담당 |
|---|---|---|
| prod 인증 OIDC 전환 | prod CD 의 정적 키(`AWS_ACCESS_KEY`)를 OIDC 역할로 교체 | cch |
| 같은 이미지 승격 | 지금은 staging(`sha-*`) 과 prod(`v*`) 가 각자 빌드한다. staging 에서 검증한 이미지를 prod ECR 로 복사해 배포하면 "검증한 바이너리 = 운영 바이너리" 가 된다 | 팀 합의 |
| 공통 모듈 통합 | alb(기존 인증서 입력) · rds(외부 SG · 삭제 보호 변수) · redis(외부 SG) 모듈 확장. prod 주소 변경은 `moved` 블록으로 막고 prod plan 무변경 확인 | 후속 PR |
| 서버 아웃바운드 축소 | `server_all` 을 ECR · SSM · Secrets Manager · Logs · S3 · 패키지 저장소로 좁히거나 VPC 엔드포인트 도입 | 후속 |
| compose 플러그인 해시 고정 | user-data 의 sha256 을 릴리스 값으로 고정 | 후속 |
| 외부 HTTPS 자동 검사 | 사내망 · VPN 에 있는 self-hosted runner 로 배포 후 `/health` 검사 | 후속 |
| 이중화 · 무중단 | ASG · 2 AZ 앱, RDS Multi-AZ, Valkey replica | prod 이전 이후 |
| prod 네트워크 이전 | `10.0.0.0/16` → `10.100.0.0/16` | cch |
| 서버 아웃바운드 · 사무실 IP 공식화 | 0-D 임시 6개 → 네트워크 담당자 목록(13장) | 사용자 |
| 룰셋 bypass | `always` → `For pull requests only` | 사용자 |

---

## 13. ALB 허용 IP 추가 · 교체

코드는 고치지 않는다. **변수 → 인프라 apply → 앱 재배포** 3단계다. 모두 변경 작업이다.

1. GitHub 변수를 **전체 목록으로 덮어쓴다**(JSON 배열, IP 마다 `/32`).
   ```bash
   gh variable get ALB_ALLOWED_IPV4_CIDRS --env staging      # 현재 값
   gh variable set ALB_ALLOWED_IPV4_CIDRS --env staging \
     --body '["1.234.191.104/32","14.52.169.47/32","<새IP>/32"]'
   ```
   - `variables.tf` 검증: 비어 있으면 안 되고, 유효한 CIDR 이어야 하며, prefix 는 `/24` 이상(더 좁게)이어야 한다. `0.0.0.0/0` · `/16` 은 plan 에서 실패한다.
2. plan 으로 확인한 뒤 apply 한다.
   ```bash
   gh workflow run infra-staging.yml --ref develop -f apply=false
   gh workflow run infra-staging.yml --ref develop -f apply=true
   ```
   - plan 에 아래만 있어야 한다: `aws_security_group_rule.alb_https` · `alb_http` **교체**, `aws_secretsmanager_secret_version.app` 변경(`SWAGGER_ALLOWED_IPS`). 다른 변경이 있으면 멈춘다.
   - `aws_security_group_rule` 은 CIDR 목록이 바뀌면 규칙을 지우고 다시 만든다 → apply 중 몇 초 접속이 끊길 수 있다.
3. 앱을 재배포한다. Swagger 허용 IP 는 앱이 기동할 때 시크릿에서 읽는다.
   ```bash
   CUR=$(aws ssm get-parameter --name /habilis-api/staging/image-tag --query Parameter.Value --output text)
   gh workflow run deploy-staging.yml --ref develop -f rollback_tag="$CUR"
   ```
   - 같은 이미지로 `deploy.sh` 가 `app.env` 를 다시 만들고 컨테이너를 교체한다. 다음 develop push 배포를 기다려도 된다.
   - 2번만 하면 새 IP 에서 ALB 는 열리지만 Swagger 는 막힌다(10-B ⑲).
4. 새 IP 에서 확인: `/health` 200, `/swagger-ui.html` 열림. 뺀 IP 에서는 타임아웃.

