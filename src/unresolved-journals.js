export const onboardingJournalKey=account=>`forsee-onboard:${account.toLowerCase()}`;
export const stopActionJournalKey=account=>`forsee:action:50383:${account.toLowerCase()}`;
export const legacyStopJournalKey=account=>`forsee:hideki2:50383:${account.toLowerCase()}`;
// Presence alone blocks writes. Never parse an unreadable or unknown journal as empty.
export function assertNoUnresolved(storage,account){
  for(const key of [onboardingJournalKey(account),stopActionJournalKey(account),legacyStopJournalKey(account)]){
    if(storage.getItem(key)!==null)throw new Error('A previous wallet action is unresolved. Check its recovery section before starting another action.');
  }
}
