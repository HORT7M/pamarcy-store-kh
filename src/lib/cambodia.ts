/** Cambodia's 25 capital/provinces with Khmer names and their districts (khan / srok / krong). */
export type Province = { code: string; en: string; km: string; districts: string[] };

export const PROVINCES: Province[] = [
  { code: "PNH", en: "Phnom Penh", km: "ភ្នំពេញ", districts: ["Boeng Keng Kang", "Chamkar Mon", "Chbar Ampov", "Chroy Changvar", "Dangkao", "Doun Penh", "Kamboul", "Mean Chey", "Pou Senchey", "Prampir Meakkakra", "Prek Pnov", "Russey Keo", "Sen Sok", "Tuol Kouk"] },
  { code: "BMC", en: "Banteay Meanchey", km: "បន្ទាយមានជ័យ", districts: ["Malai", "Mongkol Borei", "Ou Chrov", "Paoy Paet", "Phnum Srok", "Preah Netr Preah", "Serei Saophoan", "Svay Chek", "Thma Puok"] },
  { code: "BTB", en: "Battambang", km: "បាត់ដំបង", districts: ["Banan", "Battambang", "Bavel", "Ek Phnom", "Kamrieng", "Koas Krala", "Moung Ruessei", "Phnum Proek", "Rotonak Mondol", "Rukhak Kiri", "Sampov Loun", "Samlout", "Sangkae", "Thma Koul"] },
  { code: "KCM", en: "Kampong Cham", km: "កំពង់ចាម", districts: ["Batheay", "Chamkar Leu", "Cheung Prey", "Kampong Cham", "Kampong Siem", "Kang Meas", "Koh Sotin", "Prey Chhor", "Srey Santhor", "Stueng Trang"] },
  { code: "KCN", en: "Kampong Chhnang", km: "កំពង់ឆ្នាំង", districts: ["Baribour", "Chol Kiri", "Kampong Chhnang", "Kampong Leaeng", "Kampong Tralach", "Rolea B'ier", "Sameakki Mean Chey", "Tuek Phos"] },
  { code: "KSP", en: "Kampong Speu", km: "កំពង់ស្ពឺ", districts: ["Aoral", "Basedth", "Chbar Mon", "Kong Pisei", "Odongk", "Phnum Sruoch", "Samraong Tong", "Thpong"] },
  { code: "KTM", en: "Kampong Thom", km: "កំពង់ធំ", districts: ["Baray", "Kampong Svay", "Prasat Ballangk", "Prasat Sambour", "Sandan", "Santuk", "Stoung", "Stueng Saen", "Taing Kouk"] },
  { code: "KPT", en: "Kampot", km: "កំពត", districts: ["Angkor Chey", "Banteay Meas", "Bokor", "Chhuk", "Chum Kiri", "Dang Tong", "Kampong Trach", "Kampot", "Tuek Chhou"] },
  { code: "KDL", en: "Kandal", km: "កណ្ដាល", districts: ["Angk Snuol", "Kandal Stueng", "Kien Svay", "Khsach Kandal", "Koh Thum", "Leuk Daek", "Lvea Aem", "Mukh Kampul", "Ponhea Leu", "S'ang", "Ta Khmau"] },
  { code: "KEP", en: "Kep", km: "កែប", districts: ["Damnak Chang'aeur", "Kep"] },
  { code: "KKG", en: "Koh Kong", km: "កោះកុង", districts: ["Botum Sakor", "Khemara Phoumin", "Kiri Sakor", "Koh Kong", "Mondol Seima", "Srae Ambel", "Thma Bang"] },
  { code: "KRT", en: "Kratie", km: "ក្រចេះ", districts: ["Chet Borei", "Chhloung", "Kratie", "Prek Prasab", "Sambour", "Snuol"] },
  { code: "MDK", en: "Mondulkiri", km: "មណ្ឌលគិរី", districts: ["Kaev Seima", "Koh Nheaek", "Ou Reang", "Pech Chreada", "Saen Monourom"] },
  { code: "OMC", en: "Oddar Meanchey", km: "ឧត្តរមានជ័យ", districts: ["Anlong Veng", "Banteay Ampil", "Chong Kal", "Samraong", "Trapeang Prasat"] },
  { code: "PLN", en: "Pailin", km: "ប៉ៃលិន", districts: ["Pailin", "Sala Krau"] },
  { code: "PVH", en: "Preah Vihear", km: "ព្រះវិហារ", districts: ["Chey Saen", "Chhaeb", "Choam Ksant", "Kuleaen", "Preah Vihear", "Rovieng", "Sangkum Thmei", "Tbaeng Mean Chey"] },
  { code: "PVG", en: "Prey Veng", km: "ព្រៃវែង", districts: ["Ba Phnum", "Kamchay Mear", "Kampong Trabaek", "Kanhchriech", "Me Sang", "Peam Chor", "Peam Ro", "Pea Reang", "Preah Sdach", "Prey Veng", "Pur Rieng", "Sithor Kandal", "Svay Antor"] },
  { code: "PST", en: "Pursat", km: "ពោធិ៍សាត់", districts: ["Bakan", "Kandieng", "Krakor", "Phnum Kravanh", "Pursat", "Talo Senchey", "Veal Veang"] },
  { code: "RTK", en: "Ratanakiri", km: "រតនគិរី", districts: ["Andoung Meas", "Ban Lung", "Bar Kaev", "Koun Mom", "Lumphat", "Ou Chum", "Ou Ya Dav", "Ta Veaeng", "Veun Sai"] },
  { code: "SRP", en: "Siem Reap", km: "សៀមរាប", districts: ["Angkor Chum", "Angkor Thom", "Banteay Srei", "Chi Kraeng", "Kralanh", "Prasat Bakong", "Puok", "Siem Reap", "Soutr Nikom", "Srei Snam", "Svay Leu", "Varin"] },
  { code: "PSH", en: "Preah Sihanouk", km: "ព្រះសីហនុ", districts: ["Kampong Seila", "Koh Rong", "Prey Nob", "Sihanoukville", "Stueng Hav"] },
  { code: "STG", en: "Stung Treng", km: "ស្ទឹងត្រែង", districts: ["Sesan", "Siem Bouk", "Siem Pang", "Stung Treng", "Thala Barivat"] },
  { code: "SVR", en: "Svay Rieng", km: "ស្វាយរៀង", districts: ["Bavet", "Chantrea", "Kampong Rou", "Romeas Haek", "Rumduol", "Svay Chrum", "Svay Rieng", "Svay Teab"] },
  { code: "TKO", en: "Takeo", km: "តាកែវ", districts: ["Angkor Borei", "Bati", "Bourei Cholsar", "Doun Kaev", "Kiri Vong", "Koh Andaet", "Prey Kabbas", "Samraong", "Tram Kak", "Treang"] },
  { code: "TBK", en: "Tboung Khmum", km: "ត្បូងឃ្មុំ", districts: ["Dambae", "Krouch Chhmar", "Memot", "Ou Reang Ov", "Ponhea Kraek", "Suong", "Tboung Khmum"] },
];

export function findProvince(name: string | null | undefined): Province | undefined {
  if (!name) return undefined;
  return PROVINCES.find((p) => p.en === name || p.km === name || p.code === name);
}

export function provinceLabel(name: string | null | undefined, locale: string): string {
  const p = findProvince(name);
  if (!p) return name ?? "";
  return locale === "km" ? p.km : p.en;
}
