import type { NDKFilter, GetUserParams, NDKEvent } from '@nostr-dev-kit/ndk';
import type { NDKTag } from '@nostr-dev-kit/ndk/lib/src/events';
import { get as getStore } from 'svelte/store';
import ndkStore from '$lib/stores/ndk';
import { liveQuery, type Observable, type PromiseExtended } from 'dexie';
import { browser } from '$app/environment';
import { db } from '$lib/interfaces/db';
import { unixTimeNow } from '$lib/utils/helpers';

export interface GetListOpts {
    listId?: string;
    name?: string;
    kind?: number;
    authorHexPubkey?: string;
}

export interface DeleteListOpts {
    listId?: string;
}

export interface CreateListOpts {
    event: NDKEvent;
}

function listNameForEvent(event: NDKEvent): string {
    let listName = '';
    if (event.kind === 10000) listName = 'mute';
    if (event.kind === 10001) listName = 'pin';
    if (event.kind === 30000 || event.kind === 30001) {
        listName = event.getMatchingTags('d')[0][1];
    }
    return listName;
}

function listValuesForEvent(event: NDKEvent): NDKTag[] {
    const listValues: NDKTag[] = [];
    event.tags.forEach(async (tag) => {
        if (!(tag[0] === 'd')) {
            listValues.push(tag);
        }
    });
    return listValues;
}

function buildListFromEvent(event: NDKEvent): App.List {
    const listName = listNameForEvent(event);
    const listValues = listValuesForEvent(event);
    const listItem: App.List = {
        listId: event.id,
        kind: event.kind as number,
        createdAt: event.created_at as number,
        name: listName,
        content: event.content,
        authorHexPubkey: event.pubkey,
        publicItems: listValues,
        lastFetched: unixTimeNow(),
        pointer: event.encode(),
        expanded: true
    };
    return listItem;
}

const ListInterface = {
    getForUser: (opts: GetUserParams): Observable<App.List[]> => {
        const ndk = getStore(ndkStore);
        const user = ndk.getUser(opts);
        const hexPubkey = user.hexpubkey();
        const filter: NDKFilter = {
            kinds: [10000, 10001, 30000, 30001],
            authors: [hexPubkey]
        };
        let replaceableLists: App.List[] = [];

        ndk.fetchEvents(filter)
            .then(
                async (eventSet) => {
                    eventSet.forEach(async (event) => {
                        const listName = listNameForEvent(event);
                        if (listName.endsWith('/lastOpened')) return; // Skip to next if it's a client marker list
                        let returnedlists: App.List[] = [];
                        returnedlists = checkForExistingList(
                            hexPubkey,
                            listName,
                            event,
                            true
                        ) as App.List[];
                        if (returnedlists.length) {
                            replaceableLists = returnedlists;
                        }
                        // const listItem: App.List = buildListFromEvent(event);
                        // const keysToDelete: string[] = [];
                        // db.transaction('rw', db.lists, async () => {
                        //     const listCollection = db.lists.where({
                        //         authorHexPubkey: hexPubkey,
                        //         name: listName,
                        //         kind: event.kind
                        //     });
                        //     try {
                        //         if ((await listCollection.toArray()).length) {
                        //             listCollection.each(async (dbEvent, cursor) => {
                        //                 if (
                        //                     (listItem.createdAt as number) >
                        //                     (dbEvent.createdAt as number)
                        //                 ) {
                        //                     keysToDelete.push(cursor.primaryKey);
                        //                     await db.lists.put(listItem);
                        //                     replaceableLists.push(listItem);
                        //                 } else {
                        //                     // Do nothing because we already have the latest
                        //                 }
                        //             });
                        //             await db.lists.bulkDelete(keysToDelete);
                        //         } else {
                        //             await db.lists.put(listItem);
                        //             replaceableLists.push(listItem);
                        //         }
                        //     } catch (error) {
                        //         console.log(error);
                        //     }
                        // });
                    });
                },
                async () => {
                    console.log('rejected');
                }
            )
            .catch((e) => {
                console.error(e);
            });

        return liveQuery(() =>
            browser
                ? db.lists.where({ authorHexPubkey: hexPubkey }).toArray() || replaceableLists
                : replaceableLists
        ) as Observable<App.List[]>;
    },
    getCachedList: (opts: GetListOpts): Observable<App.List | undefined> => {
        return liveQuery(() => db.lists.where(opts).first());
    },
    get: (opts: GetListOpts): Observable<App.List | undefined> => {
        const ndk = getStore(ndkStore);
        let filter: NDKFilter;
        if (opts.listId) {
            filter = { ids: [opts.listId] };
        } else {
            filter = {
                kinds: [30000, 30001],
                authors: [opts.authorHexPubkey as string],
                '#d': [opts.name as string]
            };
        }
        let listItem: App.List | undefined = undefined;

        if (filter) {
            ndk.fetchEvent(filter)
                .then((fetchedEvent) => {
                    const listName = listNameForEvent(fetchedEvent);
                    const returnedList = checkForExistingList(
                        fetchedEvent.pubkey,
                        listName,
                        fetchedEvent,
                        false
                    ) as App.List;
                    if (returnedList) {
                        listItem = returnedList;
                    }
                })
                .catch((e) => {
                    console.error(e);
                });
        }

        return liveQuery(() =>
            browser ? db.lists.where(opts).first() || listItem : listItem
        ) as Observable<App.List>;
    },
    delete: (opts: DeleteListOpts): PromiseExtended<number | void> => {
        return db.lists
            .where(opts)
            .delete()
            .catch((e) => {
                console.error(e);
            });
    },
    create: (opts: CreateListOpts): PromiseExtended<string> => {
        const listItem: App.List = buildListFromEvent(opts.event);
        // Returned object is the PK of the new List
        return db.lists.put(listItem).catch((e) => {
            console.error(e);
        });
    }
};

export default ListInterface;

export function hasPeople(list: App.List): boolean {
    const itemsWithPTags = list.publicItems.filter((item) => item[0] === 'p');
    return itemsWithPTags.length > 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toggleExpanded(list: App.List): any {
    db.lists.where({ listId: list.listId }).modify({ expanded: !list.expanded });

    console.log('List toggled to', list.expanded);
}

export function userIdsForList(list: App.List): string[] {
    const userIds: string[] = [];
    list.publicItems.forEach((item) => {
        if (item[0] === 'p') {
            userIds.push(item[1]);
        }
    });
    return userIds;
}

function checkForExistingList(
    authorHexPubkey: string,
    listName: string,
    event: NDKEvent,
    returnArray: boolean
): App.List | App.List[] {
    const replaceableLists: App.List[] = [];
    const listItem: App.List = buildListFromEvent(event);
    const keysToDelete: string[] = [];

    db.transaction('rw', db.lists, async () => {
        const listCollection = db.lists.where({
            authorHexPubkey: authorHexPubkey,
            name: listName,
            kind: event.kind
        });
        try {
            if ((await listCollection.toArray()).length) {
                listCollection.each(async (dbEvent, cursor) => {
                    if ((listItem.createdAt as number) > (dbEvent.createdAt as number)) {
                        keysToDelete.push(cursor.primaryKey);
                        await db.lists.put(listItem);
                        if (returnArray) {
                            replaceableLists.push(listItem);
                        }
                    } else {
                        // Do nothing because we already have the latest
                    }
                });
                await db.lists.bulkDelete(keysToDelete);
            } else {
                await db.lists.put(listItem);
                if (returnArray) {
                    replaceableLists.push(listItem);
                }
            }
        } catch (error) {
            console.log(error);
        }
    });

    return returnArray ? replaceableLists : listItem;
}
