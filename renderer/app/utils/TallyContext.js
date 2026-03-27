import { createContext } from "react";

export const TallyContext = createContext({
  state: {},
  updateState: function () {},
  updateTallyStatus: function () {},
  fetchCompanies: function () {},
  updatePort: function () {},
});
