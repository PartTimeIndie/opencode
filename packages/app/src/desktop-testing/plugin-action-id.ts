export const pluginItemID = (pluginID: string, itemID: string) =>
  itemID.startsWith(`${pluginID}/`) ? itemID : `${pluginID}/${itemID}`
