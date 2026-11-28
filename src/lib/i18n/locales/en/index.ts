import common from "./common.json";
import storefront from "./storefront.json";
import account from "./account.json";
import catalog from "./catalog.json";
import messages from "./messages.json";
import adminCore from "./admin/core.json";
import adminCatalog from "./admin/catalog.json";
import adminInventory from "./admin/inventory.json";
import adminCommerce from "./admin/commerce.json";
import adminSystem from "./admin/system.json";

const en = {
  ...common,
  ...storefront,
  ...account,
  ...catalog,
  ...messages,
  ...adminCore,
  ...adminCatalog,
  ...adminInventory,
  ...adminCommerce,
  ...adminSystem,
};

export type Dict = typeof en;
export default en;
