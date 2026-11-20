import csharp from '@ast-grep/lang-csharp';
import java from '@ast-grep/lang-java';
import python from '@ast-grep/lang-python';
import go from '@ast-grep/lang-go';
import { registerDynamicLanguage } from '@ast-grep/napi';

// ast-grep's language registration is a shared registry; register the entire
// supported set together so one analyzer cannot replace another's languages.
registerDynamicLanguage({ csharp, java, python, go });
