/**
 * The single source of truth for the update feed.
 *
 * The update metadata must never be inferred from `.git/config`: the source repository is private
 * and stays private, and a client must never hold a GitHub token. Updates are therefore served
 * from a separate public binary repository that carries only release assets.
 *
 * This is declared explicitly in every packaging run, so the packaged `app-update.yml` and the
 * generated `latest*.yml` always point here regardless of the checkout's git remotes.
 */
export const UPDATE_FEED = Object.freeze({
  provider: 'github',
  owner: 'weijianjunwjj',
  repo: 'nova-wing-releases',
})

/** electron-builder's publish configuration for this feed. */
export const updateFeedPublishConfig = () => [{ ...UPDATE_FEED }]

/** The `owner/repo` slug, for release tooling that addresses the feed repository. */
export const UPDATE_FEED_REPOSITORY = `${UPDATE_FEED.owner}/${UPDATE_FEED.repo}`
