import {
  Folder as FilesIcon,
  Search as SearchIcon,
  Memo as TocIcon,
  ChatLineSquare as AiCommentsIcon,
  Clock as HistoryIcon,
  Setting as SettingIcon
} from '@element-plus/icons-vue'
import { t } from '@/i18n'

export interface SideBarIconEntry {
  id: string
  name: () => string
  icon: unknown
}

export const sideBarIcons: SideBarIconEntry[] = [
  {
    id: 'files',
    name: () => t('sideBar.icons.files'),
    icon: FilesIcon
  },
  {
    id: 'search',
    name: () => t('sideBar.icons.search'),
    icon: SearchIcon
  },
  {
    id: 'toc',
    name: () => t('sideBar.icons.toc'),
    icon: TocIcon
  },
  {
    id: 'aiComments',
    name: () => t('sideBar.icons.aiComments'),
    icon: AiCommentsIcon
  },
  {
    id: 'history',
    name: () => t('sideBar.icons.history'),
    icon: HistoryIcon
  }
]

export const sideBarBottomIcons: SideBarIconEntry[] = [
  {
    id: 'settings',
    name: () => t('sideBar.icons.settings'),
    icon: SettingIcon
  }
]
