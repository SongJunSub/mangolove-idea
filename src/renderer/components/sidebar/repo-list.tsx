import type { RecentRepo } from '../../../shared/types';
import { useI18n } from '../../i18n/i18n-context';
import { FolderIcon } from '../tree/tree-icons';

export interface RepoListProps {
  /** Known repos (most-recent first); exactly one may be `active`. */
  readonly repos: readonly RecentRepo[];
  /** Switch to a known repo (main focuses/opens its window). */
  onOpen(path: string): void;
  /** Add a repo via the native folder picker. */
  onAdd(): void;
}

/** Last path segment as the repo's display name. */
function repoName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * The left-sidebar repo switcher (above the file tree). Lists the recent repos and lets
 * the user move between them — clicking one focuses/opens its window; the active repo is
 * highlighted. The "+" adds a repo via the native folder picker. Replaces the titlebar's
 * old "change repo" button so a user can work across multiple repos fluidly.
 */
export function RepoList({ repos, onOpen, onAdd }: RepoListProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="repo-list" data-testid="repo-list">
      <div className="pane-head repo-list-head">
        <span className="pane-head-ico">
          <FolderIcon open={false} />
        </span>
        <span className="repo-list-title">{t('app.repoList')}</span>
        <button
          type="button"
          className="repo-add"
          data-testid="repo-add"
          title={t('app.repoAdd')}
          aria-label={t('app.repoAdd')}
          onClick={onAdd}
        >
          +
        </button>
      </div>
      <div className="repo-list-body" data-testid="repo-list-body">
        {repos.map((r) => (
          <button
            key={r.path}
            type="button"
            className={`repo-item${r.active ? ' active' : ''}`}
            data-testid={`repo-item-${repoName(r.path)}`}
            title={r.path}
            aria-current={r.active ? 'true' : undefined}
            onClick={() => {
              if (!r.active) onOpen(r.path);
            }}
          >
            <span className="repo-item-ico">
              <FolderIcon open={r.active} />
            </span>
            <span className="repo-item-name">{repoName(r.path)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
