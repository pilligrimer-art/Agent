---
name: git-workflow
version: 1.0.0
author: OpenClaw
description: Автоматический workflow работы с Git и GitHub (ветки, коммиты, PR).
triggers:
  - создай pr
  - закоммить изменения
  - гитавтоматизация
dependencies: []
tools:
  - run_command
  - github_list_repos
  - github_create_pull_request
---

# 🐙 Git & GitHub Workflow Skill

## Назначение
Безопасный атомарный цикл работы с версионированием кода и отправкой Pull Request в GitHub.

## Алгоритм работы (Workflow)
1. **Проверка статуса:** Запусти `git status` и `git diff`.
2. **Создание фиче-ветки:** Сформируй понятное имя ветки `git checkout -b feature/short-description`.
3. **Атомарный коммит:**
   - Выполни `git add .`
   - Сформируй коммит по стандарту Conventional Commits: `git commit -m "feat(scope): short summary"`
4. **Создание PR:**
   Если репозиторий привязан к GitHub — используй `github_create_pull_request` с понятным описанием изменений.
